import type { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { PURCHASE_INCLUDE } from "./ticket-includes";
import { ticketRefundTerms } from "./ticket-refund-terms";
import { hashIntent } from "@omevision/product-admin-boundary";

/** Freeze holder contacts before Event/Ticket/work; parent account deletion must never wait in the reverse order. */
export async function lockOrderDelivery(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const members = await tx.ticket.findMany({
    where: { deliveryOrderId: id },
    select: { eventId: true, userId: true },
  });
  const users = [
    ...new Set(
      members.map((ticket) => ticket.userId).filter((id): id is string => !!id),
    ),
  ].sort();
  for (const userId of users)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
  const events = [...new Set(members.map((ticket) => ticket.eventId))].sort();
  const lockedEvents: { id: string; isCancelled: boolean }[] = [];
  for (const eventId of events) {
    const rows = await tx.$queryRaw<
      { id: string; isCancelled: boolean }[]
    >`SELECT id,"isCancelled" FROM "Event" WHERE id=${eventId} FOR SHARE`;
    if (!rows[0])
      throw new ApiError("The original delivery event was not found", 409);
    lockedEvents.push(rows[0]);
  }
  await tx.$queryRaw`SELECT id FROM "Ticket" WHERE "deliveryOrderId"=${id} ORDER BY id FOR UPDATE`;
  const current = await tx.ticket.findMany({
    where: { deliveryOrderId: id },
    select: { userId: true, eventId: true },
  });
  const currentUsers = [
    ...new Set(
      current.map((ticket) => ticket.userId).filter((id): id is string => !!id),
    ),
  ].sort();
  const currentEvents = [
    ...new Set(current.map((ticket) => ticket.eventId)),
  ].sort();
  if (
    JSON.stringify(users) !== JSON.stringify(currentUsers) ||
    JSON.stringify(events) !== JSON.stringify(currentEvents)
  )
    throw new ApiError(
      "The original delivery membership changed while acquiring its locks",
      409,
    );
  await tx.$queryRaw`SELECT id FROM "TicketOrderDelivery" WHERE id=${id} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TicketDeliveryMessage" WHERE "deliveryOrderId"=${id} ORDER BY id FOR UPDATE`;
  return lockedEvents;
}

export async function deliveryDispatchState(
  id: string,
  client: Prisma.TransactionClient = prisma,
) {
  const order = await client.ticketOrderDelivery.findUnique({ where: { id } });
  if (!order) throw new ApiError("Original delivery work was not found", 404);
  const messages = await client.ticketDeliveryMessage.findMany({
    where: { deliveryOrderId: id },
    orderBy: { id: "asc" },
  });
  return { order, messages };
}
type DispatchState = Awaited<ReturnType<typeof deliveryDispatchState>>;
export const deliveryGeneration = (order: { attemptId: string | null }) =>
  order.attemptId ?? "unattempted";
/** The send command's ingress outcome is distinct from later provider delivery. */
export function deliveryAttemptOutcome(messages: DispatchState["messages"]) {
  if (!messages.length) return null;
  const error = messages
    .map((message) => message.error ?? message.gatewayError)
    .filter(Boolean)
    .join("; ");
  if (
    messages.some((message) =>
      ["unknown", "dispatching"].includes(message.state),
    )
  )
    return {
      status: "unknown" as const,
      channel: null,
      error:
        error ||
        "The original send intent is unfinished. A message may already have been sent.",
    };
  const accepted = messages.find(
    (message) => message.state === "accepted" && !!message.messageId,
  );
  if (accepted)
    return {
      status: "accepted" as const,
      channel: accepted.channel,
      error: null,
    };
  if (messages.every((message) => message.state === "failed"))
    return {
      status: "failed" as const,
      channel: messages[messages.length - 1].channel,
      error: error || "The original message was rejected before acceptance.",
    };
  throw new ApiError(
    "The original send evidence is incomplete; retain it for reconciliation",
    409,
  );
}
/** Accepted is not delivered. Both prevent automatic replacement; uncertainty requires explicit risk review. */
export function deliveryDispatchPolicy({ order, messages }: DispatchState) {
  if (
    !["pending", "sending", "sent", "failed", "unknown", "suppressed"].includes(
      order.status,
    )
  )
    throw new ApiError(
      "The original delivery state requires reconciliation",
      409,
    );
  const no = (status: string, reason: string) => ({
    canRetry: false,
    duplicateRisk: false,
    status,
    reason,
  });
  if (order.status === "suppressed")
    return no(
      "suppressed",
      order.error ??
        "This admission delivery was suppressed. Inspect its original work and proof before considering another send.",
    );
  if (
    messages.some((message) =>
      ["delivered", "read"].includes(message.gatewayStatus ?? ""),
    )
  )
    return no(
      "sent",
      "An original message has confirmed delivered/read evidence. Do not resend it.",
    );
  const current = messages.filter(
    (message) => message.dispatchAttemptId === order.attemptId,
  );
  const provenFailed =
    current.length > 0 &&
    current.every(
      (message) =>
        message.state === "failed" ||
        (message.state === "accepted" &&
          ["failed", "cancelled"].includes(message.gatewayStatus ?? "")),
    );
  if (
    current.some(
      (message) =>
        message.state === "accepted" &&
        ["scheduled", "queued", "sent", "dispatching"].includes(
          message.gatewayStatus ?? "",
        ),
    )
  )
    return no(
      "sent",
      "The original message is already accepted or being dispatched. Check its original receipt before considering another send.",
    );
  const stale =
    order.status === "sending" &&
    order.attemptedAt !== null &&
    Date.now() - order.attemptedAt.getTime() > 120_000;
  if (order.status === "sending" && !stale)
    return no(
      "sending",
      "The original delivery is still in progress. Wait for its recorded outcome.",
    );
  const uncertain =
    (!provenFailed && (order.status === "unknown" || stale)) ||
    messages.some(
      (message) =>
        ["unknown", "dispatching"].includes(message.state) ||
        message.gatewayStatus === "dispatch_unknown",
    );
  if (order.status === "sent" && !uncertain && !provenFailed)
    return no(
      "sent",
      "The original order records message acceptance. No unaccepted delivery is available to retry.",
    );
  return {
    canRetry: true,
    duplicateRisk: uncertain,
    status: uncertain ? "unknown" : order.status,
    reason: uncertain
      ? "A message may already have been sent. Retrying requires explicit acknowledgement of duplicate risk."
      : "Only this original order can be retried; no charge or new ticket is created.",
  };
}

export async function deliveryReviewEvidence(id: string, lock = false) {
  if (lock) await lockOrderDelivery(prisma, id);
  const state = await deliveryDispatchState(id);
  const tickets = await prisma.ticket.findMany({
    where: { deliveryOrderId: id },
    include: PURCHASE_INCLUDE,
    orderBy: { id: "asc" },
  });
  const charges = [
    ...new Set(
      tickets
        .map((ticket) => ticket.paymentRef)
        .filter((ref): ref is string => !!ref),
    ),
  ];
  const holds = await prisma.ticketRefundLock.findMany({
    where: { chargeId: { in: charges } },
    orderBy: { chargeId: "asc" },
  });
  return { ...state, tickets, holds };
}
/** Work generation changes during a claim; reviewed content and prior proof must not. */
export const deliveryContentVersion = (
  evidence: Awaited<ReturnType<typeof deliveryReviewEvidence>>,
) =>
  hashIntent({
    tickets: evidence.tickets,
    holds: evidence.holds,
    messages: evidence.messages,
  });
export function assertDeliveryReview(
  evidence: Awaited<ReturnType<typeof deliveryReviewEvidence>>,
  acknowledgeDuplicateRisk: boolean,
  generationId: string,
) {
  if (generationId !== deliveryGeneration(evidence.order))
    throw new ApiError(
      "The original delivery generation changed; prepare a fresh exact review",
      409,
    );
  const policy = deliveryDispatchPolicy(evidence);
  if (!policy.canRetry) throw new ApiError(policy.reason, 409);
  if (policy.duplicateRisk && !acknowledgeDuplicateRisk)
    throw new ApiError(policy.reason, 409);
  if (
    evidence.order.attemptedAt &&
    Date.now() - evidence.order.attemptedAt.getTime() < 60_000
  )
    throw new ApiError("Please wait one minute before retrying delivery.", 429);
  const first = evidence.tickets[0];
  if (
    !first?.userId ||
    evidence.tickets.some(
      (ticket) =>
        ticket.userId !== first.userId || ticket.eventId !== first.eventId,
    )
  )
    throw new ApiError(
      "The original delivery must have one verified buyer and event",
      409,
    );
  if (evidence.holds.length)
    throw new ApiError(
      "An original refund hold must be reconciled before admission delivery",
      409,
    );
  const eligible = evidence.tickets.filter(
    (ticket) =>
      ticket.status === "sold" &&
      !ticket.refundedAt &&
      !ticket.cancelledAt &&
      !ticket.event.isCancelled,
  );
  if (
    !eligible.length ||
    evidence.tickets.some((ticket) => ticket.event.isCancelled)
  )
    throw new ApiError(
      "Delivery is unavailable for this cancelled or refunded order",
      409,
    );
  eligible.forEach(ticketRefundTerms);
  return policy;
}
