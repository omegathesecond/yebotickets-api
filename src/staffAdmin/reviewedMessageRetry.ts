import { randomUUID } from "crypto";
import type { TicketDeliveryMessage } from "@prisma/client";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import {
  checkDeliveryMessage,
  deliveryMessageView,
} from "../services/delivery-message.service";
import { deliveryAttemptOutcome } from "../services/delivery-state.service";
import { prepareReviewedEffect } from "./externalEffect";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { staffOperationStore } from "./receipts";

/** One audit/receipt protocol for reviewed sends; source services own eligibility and dispatch. */
export function createReviewedMessageRetry(options: {
  operation: string;
  targetModel: string;
  workField: "deliveryOrderId" | "cancellationNoticeId";
  getWork: (id: string) => Promise<any>;
  evidence: (id: string) => Promise<any>;
  assertReview: (
    evidence: any,
    acknowledge: boolean,
    generation: string,
  ) => unknown;
  contentVersion: (evidence: any) => string;
  claim: (
    id: string,
    manual: boolean,
    acknowledge: boolean,
    attempt: string,
  ) => Promise<{ attemptId?: string }>;
  dispatch: (
    id: string,
    attempt: string,
    finalize: () => Promise<unknown>,
    beforeSend: () => Promise<void>,
  ) => Promise<any>;
}) {
  const {
    evidence: evidenceFor,
    assertReview,
    contentVersion,
    claim,
    dispatch,
  } = options;
  const fail = (message: string, status = 409) => new ApiError(message, status);
  const originalPolicy =
    "This is the original reviewed send attempt. Accepted/queued is not customer receipt. Checking proof never retries or replaces a message.";
  async function originalRetry(id: string) {
    const [audit] = await prisma.$queryRawUnsafe<any[]>(
      "SELECT * FROM staff_admin_audit WHERE id=$1::uuid AND operation=$2",
      id,
      options.operation,
    );
    const receipt = await staffOperationStore.get(id),
      intent = audit?.parameters?.reviewedEffect;
    if (
      !audit ||
      !receipt ||
      audit.staffId !== receipt.actorId ||
      receipt.targetKey !== audit.targetKey ||
      audit.targetKey !==
        `yebotickets:${options.targetModel}:${audit.parameters.id}:${audit.parameters.generationId}` ||
      !intent ||
      intent[options.workField] !== audit.parameters.id ||
      typeof intent.dispatchAttemptId !== "string"
    )
      throw fail("The original corporate message retry was not found", 404);
    const [order, messages] = await Promise.all([
      options.getWork(intent[options.workField]),
      prisma.ticketDeliveryMessage.findMany({
        where: {
          [options.workField]: intent[options.workField],
          dispatchAttemptId: intent.dispatchAttemptId,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    const attempt = deliveryAttemptOutcome(messages);
    let status: string = attempt?.status ?? "unknown";
    if (
      !attempt &&
      order &&
      order.attemptId === intent.dispatchAttemptId &&
      ["suppressed", "failed"].includes(order.status)
    )
      status = order.status;
    let recordedResult: any = null;
    if (["completed", "failed"].includes(receipt.state ?? "")) {
      const body = receipt.responseBody,
        data = body?.data;
      if (
        body?.operation?.id !== id ||
        body.operation.state !== receipt.state ||
        data?.[options.workField] !== intent[options.workField] ||
        data.dispatchAttemptId !== intent.dispatchAttemptId ||
        !["accepted", "failed", "suppressed"].includes(data.status)
      )
        throw fail(
          "The original message receipt does not match its immutable intent",
        );
      // Later work or gateway progress cannot rewrite the outcome of this command.
      recordedResult = data;
      status = data.status;
    }
    return { audit, receipt, intent, order, messages, status, recordedResult };
  }
  async function view(id: string) {
    const source = await originalRetry(id);
    return {
      id,
      [options.workField]: source.intent[options.workField],
      dispatchAttemptId: source.intent.dispatchAttemptId,
      previousAttemptId: source.intent.previousAttemptId,
      acknowledgedDuplicateRisk: source.intent.acknowledgeDuplicateRisk,
      executedBy: source.audit.staffName,
      createdAt: source.audit.createdAt,
      operationState: source.receipt.state,
      status: source.status,
      error: source.recordedResult
        ? source.recordedResult.error
        : source.order?.attemptId === source.intent.dispatchAttemptId
          ? source.order?.error
          : source.messages
              .map((message) => message.error ?? message.gatewayError)
              .filter(Boolean)
              .join("; ") || null,
      messages: source.messages.map(deliveryMessageView),
      note: originalPolicy,
    };
  }

  /** One final audit and original receipt; proof checks and immediate completion share it. */
  async function finishOriginal(id: string) {
    return staffAdminScope.transaction(async () => {
      await prisma.$queryRawUnsafe(
        "SELECT id FROM staff_admin_operations WHERE id=$1::uuid FOR UPDATE",
        id,
      );
      const source = await originalRetry(id);
      if (["completed", "failed"].includes(source.receipt.state ?? ""))
        return source.receipt.responseBody;
      if (source.status === "unknown") return null;
      const state = source.status === "failed" ? "failed" : "completed";
      const data = { ...(await view(id)), operationState: state };
      await recordStaffOperation(
        {
          id: randomUUID(),
          name: options.operation + "_finished",
          actor: {
            id: source.audit.staffId,
            name: source.audit.staffName,
            email: source.audit.staffEmail,
          },
          targetKey: source.audit.targetKey,
          parameters: { originalOperationId: id },
          reviewedVersion: "",
        },
        prisma,
        {
          status: source.status,
          dispatchAttemptId: source.intent.dispatchAttemptId,
        },
      );
      const body = {
        success: state === "completed",
        data,
        ...(state === "failed"
          ? {
              error:
                "The original message attempt was rejected. No accepted message is claimed.",
            }
          : {}),
        operation: { id, state },
      };
      await staffOperationStore.finish(
        id,
        state,
        state === "completed" ? 200 : 502,
        body,
      );
      return body;
    });
  }

  async function retry(context: StaffOperationContext) {
    const attemptId = randomUUID();
    await prepareReviewedEffect(
      context,
      options.operation,
      async () => {
        const evidence = await evidenceFor(context.parameters.id);
        assertReview(
          evidence,
          context.parameters.acknowledgeDuplicateRisk === true,
          context.parameters.generationId,
        );
        return {
          [options.workField]: evidence.order.id,
          dispatchAttemptId: attemptId,
          previousAttemptId: evidence.order.attemptId,
          acknowledgeDuplicateRisk:
            context.parameters.acknowledgeDuplicateRisk === true,
          reviewedVersion: context.reviewedVersion,
          dispatchVersion: contentVersion(evidence),
        };
      },
      async () => {
        const claimed = await claim(
          context.parameters.id,
          true,
          context.parameters.acknowledgeDuplicateRisk === true,
          attemptId,
        );
        if (!claimed.attemptId)
          throw fail(
            "The reviewed original message is no longer eligible; inspect its current receipt",
          );
      },
    );
    // The claim/critical initial audit is committed before crossing the transport boundary.
    await dispatch(
      context.parameters.id,
      attemptId,
      () => finishOriginal(context.id),
      async () => {
        const original = await originalRetry(context.id);
        const current = await evidenceFor(original.intent[options.workField]);
        if (contentVersion(current) !== original.intent.dispatchVersion)
          throw fail(
            "The reviewed original content or proof changed after the claim. No message was sent; prepare a fresh exact request.",
          );
      },
    );
    const receipt = await staffOperationStore.get(context.id);
    if (!receipt || !["completed", "failed"].includes(receipt.state ?? ""))
      throw fail(
        "The original message outcome is unconfirmed. Inspect its original attempt; do not assume it was not sent.",
        502,
      );
    return receipt.responseBody;
  }

  async function checkOriginal(id: string) {
    const source = await originalRetry(id);
    // At most one accepted channel exists in this send generation. An uncertain
    // channel has no invented ID and is never replaced by this proof-only action.
    const message = source.messages.find((message) => !!message.messageId);
    if (message) await checkDeliveryMessage(message.id);
    await finishOriginal(id);
    const current = await originalRetry(id);
    return {
      ...(await view(id)),
      originalOperationId: id,
      originalOperationState: current.receipt.state,
    };
  }

  /** Called after an existing message proof check; no second gateway read is needed. */
  async function reconcile(message: TicketDeliveryMessage) {
    if (!message[options.workField])
      return { originalOperationId: null, originalOperationState: null };
    const [audit] = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM staff_admin_audit WHERE operation=$3 AND parameters->'reviewedEffect'->>'dispatchAttemptId'=$1 AND parameters->'reviewedEffect'->>$4::text=$2`,
      message.dispatchAttemptId,
      message[options.workField],
      options.operation,
      options.workField,
    );
    if (!audit)
      return { originalOperationId: null, originalOperationState: null };
    await finishOriginal(audit.id);
    return {
      originalOperationId: audit.id,
      originalOperationState: (await staffOperationStore.get(audit.id))?.state,
    };
  }

  async function list(parameters: Record<string, any>) {
    const limit = parameters.limit ?? 20,
      page = parameters.page ?? 1;
    const [records, count] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(
        `SELECT a.id,a."staffName",a."createdAt",a.parameters->>'id' AS "workId",a.parameters->'reviewedEffect'->>'dispatchAttemptId' AS "dispatchAttemptId",o.state AS "operationState" FROM staff_admin_audit a JOIN staff_admin_operations o ON o.id=a.id WHERE a.operation=$1 ORDER BY a."createdAt" DESC,a.id LIMIT $2 OFFSET $3`,
        options.operation,
        limit,
        (page - 1) * limit,
      ),
      prisma.$queryRawUnsafe<any[]>(
        "SELECT COUNT(*)::integer AS total FROM staff_admin_audit WHERE operation=$1",
        options.operation,
      ),
    ]);
    return {
      records: records.map(({ workId, ...row }) => ({
        ...row,
        [options.workField]: workId,
      })),
      total: count[0].total,
    };
  }
  return {
    view: view,
    retry: retry,
    check: checkOriginal,
    reconcile: reconcile,
    list,
  };
}
