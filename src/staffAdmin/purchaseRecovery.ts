import { randomUUID } from "crypto";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { lockTransactionIdentity } from "../utils/transactionIdentity";
import { CURRENCY } from "../config/platform";
import { sumTicketRevenue } from "../services/settlement.service";
import { ticketRefundTerms } from "../services/ticket-refund-terms";
import {
  recoverPurchaseAttempt,
  assertOriginalPurchaseCharge,
  reconcileRefundAttempt,
} from "../services/ticket.service";
import { getCharge } from "../services/yebopay.service";
import { prepareReviewedEffect } from "./externalEffect";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { staffOperationStore } from "./receipts";
const fail = (message: string, status = 409) => new ApiError(message, status);
const page = (p: Record<string, any>) => ({
  skip: ((p.page ?? 1) - 1) * (p.limit ?? 20),
  take: p.limit ?? 20,
});

export async function purchaseEvidence(key: string, lock = false) {
  if (lock) {
    await lockTransactionIdentity(prisma, key);
    await prisma.$queryRawUnsafe(
      'SELECT key FROM "TicketPurchaseAttempt" WHERE key=$1 FOR UPDATE',
      key,
    );
  }
  const attempt = await prisma.ticketPurchaseAttempt.findUnique({
    where: { key },
  });
  if (!attempt) throw fail("The saved purchase attempt was not found", 404);
  const [tickets, buyer] = await Promise.all([
    prisma.ticket.findMany({
      where: { id: { in: attempt.ticketIds } },
      include: {
        event: { select: { id: true, title: true, isCancelled: true } },
        ticketType: { select: { name: true } },
      },
      orderBy: { id: "asc" },
    }),
    prisma.user.findUnique({
      where: { id: attempt.userId },
      select: { id: true, name: true, phoneNumber: true, email: true },
    }),
  ]);
  const original = tickets.filter(
    (ticket) =>
      ticket.userId === attempt.userId &&
      ((!ticket.paymentRef && ticket.paymentStatus === "FREE") ||
        ticket.paymentRef === attempt.attemptRef ||
        (!!attempt.chargeId && ticket.paymentRef === attempt.chargeId)),
  );
  if (
    !attempt.failure &&
    (!attempt.ticketIds.length || original.length !== attempt.ticketIds.length)
  )
    throw fail(
      "The saved purchase no longer matches its original allocated tickets",
    );
  const deliveryIds = [
    ...new Set(
      original
        .map((ticket) => ticket.deliveryOrderId)
        .filter((id): id is string => !!id),
    ),
  ];
  const [deliveries, holds] = await Promise.all([
    prisma.ticketOrderDelivery.findMany({
      where: { id: { in: deliveryIds } },
      orderBy: { id: "asc" },
    }),
    prisma.ticketRefundLock.findMany({
      where: { ticketId: { in: original.map((ticket) => ticket.id) } },
      orderBy: [
        { lastCheckedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "asc" },
      ],
    }),
  ]);
  return { attempt, tickets: original, buyer, deliveries, holds };
}
type Evidence = Awaited<ReturnType<typeof purchaseEvidence>>;
export function purchaseSnapshot(evidence: Evidence) {
  const { attempt, tickets, buyer, deliveries, holds } = evidence;
  return { attempt, tickets, buyer, deliveries, holds };
}
export function purchaseView(evidence: Evidence) {
  const { attempt, tickets, buyer, deliveries, holds } = evidence;
  let status: string,
    sourceFinal = false;
  const allocated = tickets.filter(
    (ticket) =>
      ticket.status === "reserved" && ticket.paymentStatus !== "SUCCEEDED",
  );
  if (attempt.failure) {
    if (
      tickets.some(
        (ticket) =>
          ticket.paymentStatus === "SUCCEEDED" || ticket.status === "sold",
      )
    )
      throw fail(
        "The failed purchase contradicts its original ticket payment; reconcile the original payment",
      );
    status = allocated.length ? "FAILED_NEEDS_RELEASE" : "PAYMENT_FAILED";
    sourceFinal = !allocated.length;
  } else if (tickets.every((ticket) => ticket.status === "cancelled")) {
    sourceFinal = tickets.every(
      (ticket) =>
        (ticket.paymentStatus === "FREE" &&
          ticket.amountPaid === 0 &&
          !ticket.paymentRef) ||
        (ticket.paymentStatus === "REFUNDED" &&
          !!ticket.refundAttemptId &&
          !!ticket.refundGatewayRequestId &&
          !!ticket.refundRef &&
          ticket.paymentRef === attempt.chargeId),
    );
    status = sourceFinal
      ? "CANCELLED_PURCHASE_RESOLVED"
      : "REFUND_PROOF_REQUIRED";
  } else if (tickets.some((ticket) => ticket.event.isCancelled))
    status = "CANCELLED_EVENT_REFUND_PENDING";
  else if (
    tickets.every(
      (ticket) =>
        ticket.status === "sold" &&
        ["SUCCEEDED", "FREE"].includes(ticket.paymentStatus ?? ""),
    )
  ) {
    tickets.forEach(ticketRefundTerms);
    if (
      tickets.some(
        (ticket) =>
          ticket.paymentStatus === "SUCCEEDED" &&
          ticket.paymentRef !== attempt.chargeId,
      )
    )
      throw fail("The issued tickets do not match the saved original payment");
    status = "TICKETS_ISSUED";
    sourceFinal = true;
  } else
    status = attempt.chargeId
      ? "PAYMENT_PENDING"
      : "PAYMENT_OUTCOME_UNCONFIRMED";
  const amount = tickets.length ? sumTicketRevenue(tickets) : null;
  return {
    id: attempt.key,
    buyerId: attempt.userId,
    buyerName: buyer?.name ?? null,
    eventNames: [...new Set(tickets.map((ticket) => ticket.event.title))],
    status,
    sourceFinal,
    failure: attempt.failure,
    originalAttemptRef: attempt.attemptRef,
    chargeId: attempt.chargeId,
    recordedAmount: amount,
    currency: CURRENCY,
    originalTicketCount: attempt.ticketIds.length,
    currentlyAllocated: tickets.length,
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      ticketCode: ticket.uniqueCode,
      event: ticket.event.title,
      status: ticket.status,
      paymentStatus: ticket.paymentStatus,
      amount: ticket.amountPaid,
      refundAttemptId: ticket.refundAttemptId,
      refundGatewayRequestId: ticket.refundGatewayRequestId,
    })),
    deliveries: deliveries.map((row) => ({
      id: row.id,
      status: row.status,
      channel: row.channel,
      error: row.error,
      attemptedAt: row.attemptedAt,
      sentAt: row.sentAt,
    })),
    originalRefunds: holds.map((row) => ({
      ticketId: row.ticketId,
      attemptId: row.attemptId,
      phase: row.phase,
      amount: row.amount,
      detail: row.detail,
    })),
    note: "Recovery uses the saved purchase only and never creates another charge. Ticket issuance and source-recorded message acceptance do not prove customer receipt.",
  };
}
export async function listPurchases(p: Record<string, any>) {
  const [attempts, total] = await Promise.all([
    prisma.ticketPurchaseAttempt.findMany({
      orderBy: [{ createdAt: "desc" }, { key: "asc" }],
      ...page(p),
    }),
    prisma.ticketPurchaseAttempt.count(),
  ]);
  const [buyers, tickets] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: attempts.map((row) => row.userId) } },
      select: { id: true, name: true },
    }),
    prisma.ticket.findMany({
      where: { id: { in: attempts.flatMap((row) => row.ticketIds) } },
      select: { id: true, event: { select: { title: true } } },
    }),
  ]);
  const names = new Map(buyers.map((row) => [row.id, row.name])),
    seats = new Map(tickets.map((row) => [row.id, row.event.title]));
  return {
    records: attempts.map((row) => ({
      id: row.key,
      buyerName: names.get(row.userId) ?? null,
      eventNames: [
        ...new Set(row.ticketIds.map((id) => seats.get(id)).filter(Boolean)),
      ],
      ticketCount: row.ticketIds.length,
      chargeId: row.chargeId,
      failure: row.failure,
      createdAt: row.createdAt,
    })),
    total,
  };
}
async function originalRecovery(id: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    "SELECT * FROM staff_admin_audit WHERE id=$1::uuid AND operation=$2",
    id,
    "admin_recover_purchase",
  );
  const audit = rows[0],
    receipt = await staffOperationStore.get(id);
  if (
    !audit ||
    !receipt ||
    audit.staffId !== receipt.actorId ||
    audit.targetKey !== `yebotickets:purchaseAttempt:${audit.parameters.id}`
  )
    throw fail("The original corporate purchase recovery was not found", 404);
  const evidence = await purchaseEvidence(audit.parameters.id);
  const frozen = audit.parameters.reviewedEffect.originalIntent;
  if (
    !frozen ||
    frozen.purchaseId !== evidence.attempt.key ||
    frozen.userId !== evidence.attempt.userId ||
    frozen.attemptRef !== evidence.attempt.attemptRef ||
    JSON.stringify(frozen.ticketIds) !==
      JSON.stringify(evidence.attempt.ticketIds)
  )
    throw fail(
      "The original recovery no longer matches its saved purchase identity",
    );
  if (!Array.isArray(frozen.allocations))
    throw fail("The original recovery allocation evidence is missing");
  for (const ticket of evidence.tickets) {
    const allocation = frozen.allocations.find(
      (row: any) => row.id === ticket.id,
    );
    if (allocation && allocation.amountPaid !== ticket.amountPaid)
      throw fail("The original recorded purchase allocation changed");
  }
  return { audit, receipt, evidence };
}
export async function purchaseRecoveryReceipt(id: string) {
  const { audit, receipt, evidence } = await originalRecovery(id);
  return {
    id,
    staffName: audit.staffName,
    createdAt: audit.createdAt,
    operationState: receipt.state,
    source: purchaseView(evidence),
    receipt: receipt.responseBody,
  };
}
async function finishRecovery(id: string, evidence: Evidence) {
  return staffAdminScope.transaction(async () => {
    await prisma.$queryRawUnsafe(
      "SELECT id FROM staff_admin_operations WHERE id=$1::uuid FOR UPDATE",
      id,
    );
    const { audit, receipt } = await originalRecovery(id);
    if (["completed", "failed"].includes(receipt.state ?? ""))
      return receipt.responseBody;
    const data = purchaseView(evidence);
    await recordStaffOperation(
      {
        id: randomUUID(),
        actor: {
          id: audit.staffId,
          name: audit.staffName,
          email: audit.staffEmail,
        },
        name: "admin_recover_purchase_finished",
        targetKey: audit.targetKey,
        parameters: { originalOperationId: id },
        reviewedVersion: "",
      },
      prisma,
      { status: data.status, purchaseKey: evidence.attempt.key },
    );
    const body = { success: true, data, operation: { id, state: "completed" } };
    await staffOperationStore.finish(id, "completed", 200, body);
    return body;
  });
}
export async function recoverCorporatePurchase(context: StaffOperationContext) {
  await prepareReviewedEffect(
    context,
    "admin_recover_purchase",
    async () => {
      const { attempt, tickets } = await purchaseEvidence(
        context.parameters.id,
      );
      return {
        originalIntent: {
          purchaseId: attempt.key,
          userId: attempt.userId,
          attemptRef: attempt.attemptRef,
          ticketIds: attempt.ticketIds,
          allocations: tickets.map((ticket) => ({
            id: ticket.id,
            amountPaid: ticket.amountPaid,
          })),
        },
        reviewedVersion: context.reviewedVersion,
      };
    },
    async () => undefined,
  );
  await recoverPurchaseAttempt(context.parameters.id, undefined);
  return finishRecovery(
    context.id,
    await purchaseEvidence(context.parameters.id),
  );
}
export async function checkCorporatePurchase(id: string) {
  let { evidence, receipt } = await originalRecovery(id);
  if (evidence.attempt.chargeId) {
    const charge = await getCharge(evidence.attempt.chargeId);
    // Released failed allocations no longer retain original price data. Their
    // owning failure record and original charge identity remain authoritative.
    if (!evidence.attempt.failure)
      assertOriginalPurchaseCharge(
        evidence.attempt.chargeId,
        charge,
        evidence.tickets,
      );
    else if (
      charge.id !== evidence.attempt.chargeId ||
      charge.currency !== CURRENCY
    )
      throw fail("Original failed payment identity does not match");
  }
  const hold = evidence.holds[0];
  if (hold) {
    if (
      hold.chargeId !== evidence.attempt.chargeId ||
      !evidence.attempt.ticketIds.includes(hold.ticketId)
    )
      throw fail("Original refund does not belong to this purchase");
    await reconcileRefundAttempt(hold.chargeId, hold.attemptId);
    evidence = await purchaseEvidence(evidence.attempt.key);
  }
  const source = purchaseView(evidence);
  if (
    source.sourceFinal &&
    ["running", "unknown"].includes(receipt.state ?? "")
  ) {
    await finishRecovery(id, evidence);
    receipt = (await staffOperationStore.get(id))!;
  }
  return {
    ...source,
    originalOperationId: id,
    originalOperationState: receipt.state,
  };
}

/** Resume only the persisted, actually approved purchase identity. Core recovery cannot charge again. */
export async function resumeCorporatePurchase(id: string) {
  const { audit, receipt, evidence } = await originalRecovery(id);
  if (!["running", "unknown"].includes(receipt.state ?? "")) return;
  const actor = {
    id: audit.staffId,
    name: audit.staffName,
    email: audit.staffEmail,
  };
  await staffAdminScope.context(actor, async () => {
    await recoverPurchaseAttempt(evidence.attempt.key, undefined);
    await finishRecovery(id, await purchaseEvidence(evidence.attempt.key));
  });
}
export async function recoverCorporatePurchases() {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT o.id FROM staff_admin_operations o JOIN staff_admin_audit a ON a.id=o.id WHERE o.state IN ('running','unknown') AND a.operation='admin_recover_purchase' ORDER BY o."updatedAt" LIMIT 10`,
  );
  for (const row of rows) await resumeCorporatePurchase(row.id);
}
