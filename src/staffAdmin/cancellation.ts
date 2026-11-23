import { randomUUID } from "crypto";
import { hashIntent } from "@omevision/product-admin-boundary";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { CURRENCY } from "../config/platform";
import {
  beginEventCancellation,
  refundTicket,
  reconcileRefundAttempt,
} from "../services/ticket.service";
import { ticketRefundTerms } from "../services/ticket-refund-terms";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { staffOperationStore } from "./receipts";
import { review } from "./reviewTarget";

const fail = (message: string, status = 409) => new ApiError(message, status);
type Member = {
  ticketId: string;
  ticketCode: string;
  userId: string | null;
  paymentRef: string | null;
  amount: number | null;
  eligible: boolean;
  operationId: string;
  reviewedVersion: string | null;
  existingAttemptId: string | null;
};
type Evidence = {
  tickets: Map<string, any>;
  receipts: Map<string, any>;
  purchases: Map<string, any>;
  holds: Map<string, any>;
};
type Manifest = {
  operationId: string;
  eventId: string;
  eventTitle: string;
  members: Member[];
};
const parameters = (member: Member, parent: string) => ({
  id: member.ticketId,
  reason: `Ticket from approved event cancellation ${parent}`,
});
export async function cancellationManifest(id: string): Promise<Manifest> {
  const rows = await prisma.$queryRawUnsafe<Manifest[]>(
    'SELECT * FROM staff_admin_event_cancellations WHERE "operationId"=$1::uuid',
    id,
  );
  if (!rows.length)
    throw fail("The original event cancellation was not found", 404);
  return rows[0];
}

/** Only original owning purchase evidence can bind a formerly pending payment. */
async function originalPurchase(member: Member, evidence?: Evidence) {
  if (!member.paymentRef) return null;
  const attempt = evidence
    ? evidence.purchases.get(member.paymentRef)
    : await prisma.ticketPurchaseAttempt.findFirst({
        where: {
          ...(member.paymentRef.startsWith("attempt:")
            ? { attemptRef: member.paymentRef }
            : { chargeId: member.paymentRef }),
        },
      });
  if (
    attempt &&
    (attempt.userId !== member.userId ||
      !attempt.ticketIds.includes(member.ticketId))
  )
    throw fail("The original cancellation purchase identity does not match");
  return attempt;
}
async function memberOutcome(member: Member, evidence?: Evidence) {
  const ticket = evidence
    ? evidence.tickets.get(member.ticketId)
    : await prisma.ticket.findUnique({
        where: { id: member.ticketId },
      });
  if (!ticket) throw fail("An original cancellation ticket is missing");
  const receipt = evidence
    ? evidence.receipts.get(member.operationId)
    : await staffOperationStore.get(member.operationId);
  const purchase = member.eligible
    ? null
    : await originalPurchase(member, evidence);
  const originalCharge = member.paymentRef?.startsWith("attempt:")
    ? purchase?.chargeId
    : member.paymentRef;
  if (
    ticket.status === "cancelled" &&
    ticket.userId === member.userId &&
    ticket.amountPaid === member.amount
  ) {
    if (
      member.amount === 0 &&
      !member.paymentRef &&
      ticket.paymentStatus === "FREE" &&
      !ticket.paymentRef
    )
      return {
        ticketId: member.ticketId,
        ticketCode: member.ticketCode,
        amount: 0,
        currency: CURRENCY,
        status: "CANCELLED_FREE",
        resolved: true,
        operationId: receipt?.id ?? null,
        plannedOperationId: member.operationId,
      };
    if (
      originalCharge &&
      ticket.paymentRef === originalCharge &&
      ticket.paymentStatus === "REFUNDED" &&
      ticket.refundAttemptId &&
      ticket.refundGatewayRequestId &&
      ticket.refundRef
    )
      return {
        ticketId: member.ticketId,
        ticketCode: member.ticketCode,
        amount: member.amount,
        currency: CURRENCY,
        status: "REFUNDED",
        resolved: true,
        operationId: receipt?.id ?? null,
        plannedOperationId: member.operationId,
        resolvedByAttemptId: ticket.refundAttemptId,
        gatewayRequestId: ticket.refundGatewayRequestId,
        refundRef: ticket.refundRef,
      };
  }
  if (
    !member.eligible &&
    purchase?.failure &&
    (ticket.status === "available" ||
      ticket.userId !== member.userId ||
      (ticket.paymentRef !== member.paymentRef &&
        ticket.paymentRef !== purchase.chargeId))
  )
    return {
      ticketId: member.ticketId,
      ticketCode: member.ticketCode,
      amount: member.amount,
      currency: CURRENCY,
      status: "ORIGINAL_PAYMENT_FAILED_AND_RELEASED",
      resolved: true,
      purchaseAttempt: purchase.attemptRef,
    };
  if (receipt?.state === "completed")
    throw fail(
      "An original child receipt disagrees with its saved ticket outcome",
    );
  const hold = evidence
    ? evidence.holds.get(member.ticketId)
    : await prisma.ticketRefundLock.findFirst({
        where: { ticketId: member.ticketId },
      });
  return {
    ticketId: member.ticketId,
    ticketCode: member.ticketCode,
    amount: member.amount,
    currency: CURRENCY,
    status:
      receipt?.state === "failed"
        ? "NEEDS_FRESH_REFUND_REVIEW"
        : hold
          ? "ORIGINAL_REFUND_UNRESOLVED"
          : member.eligible
            ? receipt
              ? "ORIGINAL_SENDER_UNRESOLVED"
              : "NOT_STARTED"
            : member.existingAttemptId
              ? "NEEDS_FRESH_REFUND_REVIEW"
              : "AWAITING_ORIGINAL_PAYMENT",
    resolved: false,
    operationId: receipt?.id ?? null,
    plannedOperationId: member.operationId,
    attemptId: hold?.attemptId ?? null,
    error: receipt?.responseBody?.error ?? null,
    note: !member.eligible
      ? "Use the existing purchase recovery. A newly confirmed payment can use an exact ticket refund review; it is never dispatched by a proof check."
      : receipt?.state === "failed"
        ? "The original failed attempt is retained. Prepare a fresh exact ticket refund if still required."
        : null,
  };
}
export async function cancellationView(id: string) {
  const manifest = await cancellationManifest(id);
  const original = await staffOperationStore.get(id);
  if (!original) throw fail("The original cancellation operation is missing");
  const ids = manifest.members.map((member) => member.ticketId);
  const refs = manifest.members
    .filter((member) => !member.eligible && member.paymentRef)
    .map((member) => member.paymentRef!);
  const [tickets, receipts, purchases, holds] = await Promise.all([
    prisma.ticket.findMany({ where: { id: { in: ids } } }),
    prisma.$queryRawUnsafe<any[]>(
      "SELECT * FROM staff_admin_operations WHERE id=ANY($1::uuid[])",
      manifest.members.map((member) => member.operationId),
    ),
    prisma.ticketPurchaseAttempt.findMany({
      where: { OR: [{ attemptRef: { in: refs } }, { chargeId: { in: refs } }] },
    }),
    prisma.ticketRefundLock.findMany({ where: { ticketId: { in: ids } } }),
  ]);
  const evidence: Evidence = {
    tickets: new Map(tickets.map((row) => [row.id, row])),
    receipts: new Map(receipts.map((row) => [row.id, row])),
    purchases: new Map(),
    holds: new Map(),
  };
  for (const row of purchases) {
    evidence.purchases.set(row.attemptRef, row);
    if (row.chargeId) evidence.purchases.set(row.chargeId, row);
  }
  for (const row of holds) {
    if (evidence.holds.has(row.ticketId))
      throw fail(
        "Multiple original refund holds reference one cancellation ticket",
      );
    evidence.holds.set(row.ticketId, row);
  }
  const records: Awaited<ReturnType<typeof memberOutcome>>[] = [];
  for (const member of manifest.members)
    records.push(await memberOutcome(member, evidence));
  return {
    id,
    eventId: manifest.eventId,
    eventTitle: manifest.eventTitle,
    operationState: original.state,
    lastError: original.responseBody?.error ?? null,
    lastPassErrors: original.responseBody?.data?.passErrors ?? null,
    total: records.length,
    resolved: records.filter((row) => row.resolved).length,
    remaining: records.filter((row) => !row.resolved).length,
    records,
    notificationNote:
      "Financial outcomes do not prove holder-notification delivery. Proof checks send no notice.",
  };
}
/** Keep parent completion and proof fencing in the same Event-before-Ticket lock order. */
async function lockCancelledEvent(eventId: string) {
  const events = await prisma.$queryRawUnsafe<any[]>(
    'SELECT id,"isCancelled" FROM "Event" WHERE id=$1 FOR UPDATE',
    eventId,
  );
  if (!events[0]?.isCancelled)
    throw fail("The original event is no longer cancelled");
}
async function refreshParent(
  id: string,
  passErrors: Array<{ ticketId: string; error: string }> = [],
  holderNotifications: Array<{
    ticketId: string;
    notified: boolean;
    error: string | null;
  }> = [],
) {
  return staffAdminScope.transaction(async () => {
    const manifest = await cancellationManifest(id);
    await lockCancelledEvent(manifest.eventId);
    await prisma.$queryRawUnsafe(
      'SELECT id FROM "Ticket" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',
      manifest.members.map((m) => m.ticketId),
    );
    const data = await cancellationView(id);
    const completed = data.remaining === 0;
    const original = await staffOperationStore.get(id);
    if (original?.state === "completed") return original.responseBody;
    if (completed) {
      const audits = await prisma.$queryRawUnsafe<any[]>(
        "SELECT * FROM staff_admin_audit WHERE id=$1::uuid AND operation=$2",
        id,
        "admin_cancel_event",
      );
      const audit = audits[0];
      if (!audit || original?.actorId !== audit.staffId)
        throw fail("The original cancellation actor is missing");
      await recordStaffOperation(
        {
          id: randomUUID(),
          actor: {
            id: audit.staffId,
            name: audit.staffName,
            email: audit.staffEmail,
          },
          name: "admin_cancel_event_finalized",
          targetKey: audit.targetKey,
          parameters: { originalOperationId: id },
          reviewedVersion: audit.parameters.reviewedEffect.reviewedVersion,
        },
        prisma,
        {
          eventId: manifest.eventId,
          ticketCount: data.total,
          resolved: data.resolved,
        },
      );
    }
    const body = {
      success: completed,
      ...(completed
        ? {}
        : {
            error:
              "Event cancellation is active. Original ticket outcomes still require continuation or proof recovery.",
          }),
      data: {
        ...data,
        operationState: completed ? "completed" : "unknown",
        lastError: completed
          ? null
          : "Original cancellation outcomes remain unresolved",
        lastPassErrors: passErrors,
        passErrors,
        holderNotifications,
      },
      operation: { id, state: completed ? "completed" : "unknown" },
    };
    await staffOperationStore.finish(
      id,
      completed ? "completed" : "unknown",
      completed ? 200 : 502,
      body,
    );
    return body;
  });
}
export async function startCorporateCancellation(
  context: StaffOperationContext,
) {
  try {
    await staffAdminScope.transaction(async () => {
      const target = await review(context.name, context.parameters, true);
      const original = await staffOperationStore.get(context.id);
      if (
        context.name !== "admin_cancel_event" ||
        staffAdminScope.actor()?.id !== context.actor.id ||
        original?.actorId !== context.actor.id ||
        !["running", "unknown"].includes(original?.state ?? "")
      )
        throw fail("A verified active cancellation decision is required", 401);
      if (target.version !== context.reviewedVersion)
        throw fail("Target changed since review; prepare a fresh cancellation");
      const { event, tickets } = await beginEventCancellation(
        context.parameters.id,
        undefined,
      );
      const members: Member[] = [];
      for (const ticket of tickets) {
        const settled =
          ticket.status === "sold" || ticket.paymentStatus === "SUCCEEDED";
        if (settled) ticketRefundTerms(ticket);
        const hold = await prisma.ticketRefundLock.findFirst({
          where: {
            OR: [
              { ticketId: ticket.id },
              ...(ticket.paymentRef ? [{ chargeId: ticket.paymentRef }] : []),
            ],
          },
        });
        const eligible = settled && !hold;
        const member: Member = {
          ticketId: ticket.id,
          ticketCode: ticket.uniqueCode,
          userId: ticket.userId,
          paymentRef: ticket.paymentRef,
          amount: ticket.amountPaid,
          eligible,
          operationId: randomUUID(),
          reviewedVersion: null,
          existingAttemptId: hold?.attemptId ?? null,
        };
        if (eligible)
          member.reviewedVersion = (
            await review("admin_refund_ticket", parameters(member, context.id))
          ).version;
        members.push(member);
      }
      await recordStaffOperation(context, prisma, {
        eventId: event.id,
        ticketCount: members.length,
        plannedChildOperationIds: members.map((m) => m.operationId),
        reviewedVersion: context.reviewedVersion,
      });
      await prisma.$executeRawUnsafe(
        'INSERT INTO staff_admin_event_cancellations("operationId","eventId","eventTitle",members) VALUES($1::uuid,$2,$3,$4::jsonb)',
        context.id,
        event.id,
        event.title,
        JSON.stringify(members),
      );
    });
  } catch (error: any) {
    if (error.corporateRollbackConfirmed === true)
      await staffOperationStore.finish(
        context.id,
        "failed",
        error.statusCode ?? 500,
        {
          success: false,
          error: error.message,
          operation: { id: context.id, state: "failed" },
        },
      );
    throw error;
  }
  return continueCorporateCancellation(context.id, context);
}

/** Dispatch only never-started, originally reviewed children; never replace a failed/unknown attempt. */
export async function continueCorporateCancellation(
  id: string,
  context: StaffOperationContext,
) {
  if (
    staffAdminScope.actor()?.id !== context.actor.id ||
    !["admin_cancel_event", "admin_continue_cancellation"].includes(
      context.name,
    )
  )
    throw fail("A verified cancellation execution is required", 401);
  const manifest = await cancellationManifest(id);
  const errors: Array<{ ticketId: string; error: string }> = [];
  const notifications: Array<{
    ticketId: string;
    notified: boolean;
    error: string | null;
  }> = [];
  const deadline = Date.now() + 5000;
  let started = 0;
  for (const member of manifest.members) {
    if (!member.eligible || Date.now() >= deadline || started >= 10) continue;
    try {
      const state = await memberOutcome(member);
      if (state.resolved || (await staffOperationStore.get(member.operationId)))
        continue;
      // A previous ticket on the same charge may still be awaiting original proof.
      if (
        member.paymentRef &&
        (await prisma.ticketRefundLock.findUnique({
          where: { chargeId: member.paymentRef },
        }))
      )
        continue;
      const p = parameters(member, id);
      const claimed = await staffAdminScope.transaction(async () => {
        const target = await review("admin_refund_ticket", p, true);
        if (target.version !== member.reviewedVersion)
          throw fail(
            "An original ticket changed; prepare a fresh exact refund review",
          );
        return staffOperationStore.claim({
          id: member.operationId,
          actorId: context.actor.id,
          method: "POST",
          path: `/tickets/${member.ticketId}/refund`,
          requestHash: hashIntent({
            cancellationId: id,
            parameters: p,
            targetVersion: member.reviewedVersion,
          }),
          targetKey: `yebotickets:ticket:${member.ticketId}`,
        });
      });
      if (!claimed) continue;
      started++;
      const outcome = await refundTicket(member.ticketId, undefined, p.reason, {
        id: member.operationId,
        actor: context.actor,
        name: "admin_refund_ticket",
        parameters: p,
        targetKey: `yebotickets:ticket:${member.ticketId}`,
        reviewedVersion: member.reviewedVersion!,
        parentOperationId: id,
      });
      notifications.push({
        ticketId: member.ticketId,
        notified: outcome.notified,
        error: outcome.notifyError ?? null,
      });
    } catch (error: any) {
      const child = await staffOperationStore.get(member.operationId);
      if (child && ["running", "unknown"].includes(child.state ?? "")) {
        await staffOperationStore.finish(
          member.operationId,
          "unknown",
          error.statusCode ?? 502,
          {
            success: false,
            error: error.message,
            operation: { id: member.operationId, state: "unknown" },
          },
        );
      }
      errors.push({ ticketId: member.ticketId, error: error.message });
    }
  }
  return refreshParent(id, errors, notifications);
}

/** Recovery only reads original gateway proof. It never starts any refund or sends a notice. */
export async function checkCorporateCancellation(id: string) {
  const manifest = await cancellationManifest(id);
  // Parent aggregation locks Event before Ticket. Take that same first lock
  // before fencing any child, so a proof check cannot hold Ticket while waiting
  // for a worker that already holds Event and needs that Ticket.
  await lockCancelledEvent(manifest.eventId);
  // One original provider read per pass fits the owning gateway's two 15s
  // timeouts. Never-checked/oldest pending attempts rotate instead of starving
  // behind the first unconfirmed payment. Terminal proofs remove their hold.
  const holds = await prisma.ticketRefundLock.findMany({
    where: {
      ticketId: { in: manifest.members.map((member) => member.ticketId) },
    },
    orderBy: [
      { lastCheckedAt: { sort: "asc", nulls: "first" } },
      { createdAt: "asc" },
      { chargeId: "asc" },
    ],
    take: 1,
  });
  const byTicket = new Map(
    manifest.members.map((member) => [member.ticketId, member]),
  );
  for (const hold of holds) {
    const member = byTicket.get(hold.ticketId)!;
    const purchase = member.paymentRef?.startsWith("attempt:")
      ? await originalPurchase(member)
      : null;
    const originalCharge = member.paymentRef?.startsWith("attempt:")
      ? purchase?.chargeId
      : member.paymentRef;
    if (
      !originalCharge ||
      hold.chargeId !== originalCharge ||
      hold.amount !== member.amount
    )
      throw fail(
        "The refund hold does not match the originally reviewed cancellation payment",
      );
    await reconcileRefundAttempt(hold.chargeId, hold.attemptId);
  }
  const senders = await prisma.$queryRawUnsafe<any[]>(
    `SELECT o.id FROM staff_admin_operations o LEFT JOIN staff_admin_audit a ON a.id=o.id WHERE o.id=ANY($1::uuid[]) AND o.state IN ('running','unknown') AND a.id IS NULL ORDER BY o.path LIMIT 20`,
    manifest.members.map((member) => member.operationId),
  );
  const members = new Map(
    manifest.members.map((member) => [member.operationId, member]),
  );
  for (const sender of senders) {
    const member = members.get(sender.id)!;
    // Fence a sender that claimed its child operation but never committed
    // the required initial audit/charge hold. A delayed sender rechecks this
    // terminal receipt while holding the same ticket lock before any effect.
    await prisma.$queryRawUnsafe(
      'SELECT id FROM "Ticket" WHERE id=$1 FOR UPDATE',
      member.ticketId,
    );
    const receipt = await staffOperationStore.get(member.operationId);
    const audit = await prisma.$queryRawUnsafe<any[]>(
      "SELECT id FROM staff_admin_audit WHERE id=$1::uuid",
      member.operationId,
    );
    if (
      receipt &&
      ["running", "unknown"].includes(receipt.state ?? "") &&
      !audit.length
    ) {
      const racedHold = await prisma.ticketRefundLock.findFirst({
        where: { ticketId: member.ticketId },
      });
      if (racedHold)
        throw fail(
          "The original refund sender advanced; check original proof again",
        );
      await staffOperationStore.finish(member.operationId, "failed", 409, {
        success: false,
        error:
          "The original child never committed its dispatch intent. It is fenced; a fresh exact refund needs review.",
        operation: { id: member.operationId, state: "failed" },
      });
    }
  }
  return refreshParent(id);
}

/** Resume a durable, already approved manifest, never a manufactured product session. */
export async function recoverCorporateCancellations(onlyId?: string) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT c."operationId",a."staffId",a."staffName",a."staffEmail",a.parameters,o."actorId",o."targetKey" FROM staff_admin_event_cancellations c JOIN staff_admin_operations o ON o.id=c."operationId" JOIN staff_admin_audit a ON a.id=c."operationId" WHERE o.state IN ('running','unknown') AND a.operation='admin_cancel_event' ${onlyId ? 'AND c."operationId"=$1::uuid' : ""} ORDER BY o."updatedAt",c."createdAt" LIMIT 20`,
    ...(onlyId ? [onlyId] : []),
  );
  for (const row of rows) {
    if (
      row.staffId !== row.actorId ||
      row.targetKey !== `yebotickets:event:${row.parameters.id}`
    )
      throw fail(
        "The saved cancellation approval and corporate actor do not match",
      );
    const approved = row.parameters.reviewedEffect;
    const manifest = await cancellationManifest(row.operationId);
    if (
      !approved ||
      !Array.isArray(approved.plannedChildOperationIds) ||
      !/^[a-f0-9]{64}$/.test(approved.reviewedVersion ?? "") ||
      approved.eventId !== manifest.eventId ||
      hashIntent(approved.plannedChildOperationIds) !==
        hashIntent(manifest.members.map((m) => m.operationId))
    )
      throw fail(
        "The durable cancellation manifest does not match its actual approved intent",
      );
    const actor = {
      id: row.staffId,
      name: row.staffName,
      email: row.staffEmail,
    };
    try {
      await staffAdminScope.context(actor, () =>
        continueCorporateCancellation(row.operationId, {
          id: row.operationId,
          actor,
          name: "admin_cancel_event",
          targetKey: row.targetKey,
          parameters: row.parameters,
          reviewedVersion: approved.reviewedVersion,
        }),
      );
    } catch (error: any) {
      await staffOperationStore.finish(row.operationId, "unknown", 502, {
        success: false,
        error: error.message,
        operation: { id: row.operationId, state: "unknown" },
      });
      throw error;
    }
  }
}
