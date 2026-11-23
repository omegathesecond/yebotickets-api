import { randomUUID } from "crypto";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import {
  claimOrderDelivery,
  dispatchClaimedOrderDelivery,
} from "../services/ticket.service";
import {
  checkDeliveryMessage,
  deliveryMessageView,
} from "../services/delivery-message.service";
import {
  deliveryReviewEvidence,
  assertDeliveryReview,
  deliveryContentVersion,
  deliveryAttemptOutcome,
} from "../services/delivery-state.service";
import { prepareReviewedEffect } from "./externalEffect";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { staffOperationStore } from "./receipts";

const fail = (message: string, status = 409) => new ApiError(message, status);
const originalPolicy =
  "This is the original reviewed send attempt. Accepted/queued is not customer receipt. Checking proof never retries or replaces a message.";
async function originalRetry(id: string) {
  const [audit] = await prisma.$queryRawUnsafe<any[]>(
    "SELECT * FROM staff_admin_audit WHERE id=$1::uuid AND operation=$2",
    id,
    "admin_retry_delivery",
  );
  const receipt = await staffOperationStore.get(id),
    intent = audit?.parameters?.reviewedEffect;
  if (
    !audit ||
    !receipt ||
    audit.staffId !== receipt.actorId ||
    receipt.targetKey !== audit.targetKey ||
    audit.targetKey !==
      `yebotickets:deliveryOrder:${audit.parameters.id}:${audit.parameters.generationId}` ||
    !intent ||
    intent.deliveryOrderId !== audit.parameters.id ||
    typeof intent.dispatchAttemptId !== "string"
  )
    throw fail("The original corporate delivery retry was not found", 404);
  const [order, messages] = await Promise.all([
    prisma.ticketOrderDelivery.findUnique({
      where: { id: intent.deliveryOrderId },
    }),
    prisma.ticketDeliveryMessage.findMany({
      where: {
        deliveryOrderId: intent.deliveryOrderId,
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
      data?.deliveryOrderId !== intent.deliveryOrderId ||
      data.dispatchAttemptId !== intent.dispatchAttemptId ||
      !["accepted", "failed", "suppressed"].includes(data.status)
    )
      throw fail(
        "The original delivery receipt does not match its immutable intent",
      );
    // Later work or gateway progress cannot rewrite the outcome of this command.
    recordedResult = data;
    status = data.status;
  }
  return { audit, receipt, intent, order, messages, status, recordedResult };
}
export async function deliveryRetryView(id: string) {
  const source = await originalRetry(id);
  return {
    id,
    deliveryOrderId: source.intent.deliveryOrderId,
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
async function finishOriginalRetry(id: string) {
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
    const data = { ...(await deliveryRetryView(id)), operationState: state };
    await recordStaffOperation(
      {
        id: randomUUID(),
        name: "admin_retry_delivery_finished",
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
              "The original delivery attempt was rejected. No accepted message is claimed.",
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

export async function retryCorporateDelivery(context: StaffOperationContext) {
  const attemptId = randomUUID();
  await prepareReviewedEffect(
    context,
    "admin_retry_delivery",
    async () => {
      const evidence = await deliveryReviewEvidence(context.parameters.id);
      assertDeliveryReview(
        evidence,
        context.parameters.acknowledgeDuplicateRisk === true,
        context.parameters.generationId,
      );
      return {
        deliveryOrderId: evidence.order.id,
        dispatchAttemptId: attemptId,
        previousAttemptId: evidence.order.attemptId,
        acknowledgeDuplicateRisk:
          context.parameters.acknowledgeDuplicateRisk === true,
        reviewedVersion: context.reviewedVersion,
        dispatchVersion: deliveryContentVersion(evidence),
      };
    },
    async () => {
      const claim = await claimOrderDelivery(
        context.parameters.id,
        true,
        context.parameters.acknowledgeDuplicateRisk === true,
        attemptId,
      );
      if (!claim.attemptId)
        throw fail(
          "The reviewed original delivery is no longer eligible; inspect its current receipt",
        );
    },
  );
  // The claim/critical initial audit is committed before crossing the transport boundary.
  await dispatchClaimedOrderDelivery(
    context.parameters.id,
    attemptId,
    () => finishOriginalRetry(context.id),
    async () => {
      const original = await originalRetry(context.id);
      const current = await deliveryReviewEvidence(
        original.intent.deliveryOrderId,
      );
      if (deliveryContentVersion(current) !== original.intent.dispatchVersion)
        throw fail(
          "The reviewed buyer, tickets or original proof changed after the claim. No message was sent; prepare a fresh exact request.",
        );
    },
  );
  const receipt = await staffOperationStore.get(context.id);
  if (!receipt || !["completed", "failed"].includes(receipt.state ?? ""))
    throw fail(
      "The original delivery outcome is unconfirmed. Inspect its original attempt; do not assume it was not sent.",
      502,
    );
  return receipt.responseBody;
}

export async function checkOriginalDeliveryRetry(id: string) {
  const source = await originalRetry(id);
  // At most one accepted channel exists in this send generation. An uncertain
  // channel has no invented ID and is never replaced by this proof-only action.
  const message = source.messages.find((message) => !!message.messageId);
  if (message) await checkDeliveryMessage(message.id);
  await finishOriginalRetry(id);
  const current = await originalRetry(id);
  return {
    ...(await deliveryRetryView(id)),
    originalOperationId: id,
    originalOperationState: current.receipt.state,
  };
}

/** Called after an existing message proof check; no second gateway read is needed. */
export async function reconcileDeliveryRetryForMessage(messageId: string) {
  const message = await prisma.ticketDeliveryMessage.findUnique({
    where: { id: messageId },
  });
  if (!message) throw fail("The original delivery message was not found", 404);
  const [audit] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id FROM staff_admin_audit WHERE operation='admin_retry_delivery' AND parameters->'reviewedEffect'->>'dispatchAttemptId'=$1 AND parameters->'reviewedEffect'->>'deliveryOrderId'=$2`,
    message.dispatchAttemptId,
    message.deliveryOrderId,
  );
  if (!audit)
    return { originalOperationId: null, originalOperationState: null };
  await finishOriginalRetry(audit.id);
  return {
    originalOperationId: audit.id,
    originalOperationState: (await staffOperationStore.get(audit.id))?.state,
  };
}
