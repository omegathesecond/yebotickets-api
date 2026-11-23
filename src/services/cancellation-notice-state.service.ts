import type { Prisma, TicketCancellationNotice } from "@prisma/client";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { CURRENCY } from "../config/platform";
import { hashIntent } from "@omevision/product-admin-boundary";
import {
  deliveryDispatchPolicy,
  deliveryGeneration,
} from "./delivery-state.service";
import { formatPhone } from "../utils/phone";

/** Save with the actual financial finalization, never inferred from an old cancellation. */
export async function enqueueCancellationNotice(
  tx: Prisma.TransactionClient,
  ticketId: string,
) {
  const ticket = await tx.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: { event: true, user: true },
  });
  const refunded = ticket.paymentStatus === "REFUNDED";
  if (
    ticket.status !== "cancelled" ||
    !ticket.cancelledAt ||
    !ticket.event.title ||
    (refunded
      ? !ticket.refundAttemptId ||
        !ticket.refundGatewayRequestId ||
        !ticket.refundedAt ||
        typeof ticket.amountPaid !== "number" ||
        !Number.isFinite(ticket.amountPaid) ||
        ticket.amountPaid <= 0
      : ticket.paymentStatus !== "FREE" || ticket.amountPaid !== 0)
  )
    throw new ApiError(
      "The original finalized cancellation evidence is incomplete; no notice intent was created",
      409,
    );
  const amount = refunded ? ticket.amountPaid! : 0;
  const existing = await tx.ticketCancellationNotice.findUnique({
    where: { ticketId },
  });
  if (existing) {
    if (
      existing.refunded !== refunded ||
      existing.amount !== amount ||
      existing.refundAttemptId !== ticket.refundAttemptId ||
      existing.refundGatewayRequestId !== ticket.refundGatewayRequestId ||
      existing.eventId !== ticket.eventId ||
      existing.ticketCode !== ticket.uniqueCode
    )
      throw new ApiError(
        "The original cancellation notice conflicts with financial evidence",
        409,
      );
    return existing;
  }
  const lines = [
    `❌ Your ticket for ${ticket.event.title} has been cancelled.`,
  ];
  if (refunded)
    lines.push(
      `💸 A refund of ${amount.toFixed(2)} ${CURRENCY} has been issued to your original payment method.`,
    );
  lines.push(`🔑 Ticket code: ${ticket.uniqueCode}`);
  return tx.ticketCancellationNotice.create({
    data: {
      ticketId,
      eventId: ticket.eventId,
      userId: ticket.userId,
      ticketCode: ticket.uniqueCode,
      eventTitle: ticket.event.title,
      recipient: ticket.user?.phoneNumber
        ? formatPhone(ticket.user.phoneNumber)
        : null,
      refunded,
      amount,
      currency: CURRENCY,
      refundAttemptId: ticket.refundAttemptId,
      refundGatewayRequestId: ticket.refundGatewayRequestId,
      content: lines.join("\n"),
    },
  });
}

/** Independent immutable intent: no live parent locks or foreign-key deletion dependency. */
export async function lockCancellationNotice(
  tx: Prisma.TransactionClient,
  id: string,
) {
  await tx.$queryRaw`SELECT id FROM "TicketCancellationNotice" WHERE id=${id} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TicketDeliveryMessage" WHERE "cancellationNoticeId"=${id} ORDER BY id FOR UPDATE`;
}

export async function cancellationNoticeRecord(id: string) {
  const evidence = await noticeReviewEvidence(id),
    notice = evidence.order;
  const policy = deliveryDispatchPolicy(evidence);
  let retryAvailable = policy.canRetry,
    retryReason = policy.reason;
  if (retryAvailable)
    try {
      assertNoticeReview(evidence, true, deliveryGeneration(notice));
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![409, 429].includes(error.statusCode)
      )
        throw error;
      retryAvailable = false;
      retryReason = error.message;
    }
  return {
    ...cancellationNoticeView(notice),
    generationId: deliveryGeneration(notice),
    retryAvailable,
    duplicateRiskAcknowledgementRequired:
      policy.canRetry && policy.duplicateRisk,
    retryReason,
    note: "Financial completion and message delivery are separate. Sent records acceptance only. Unknown notices may already have been sent and are never automatically retried. The original recipient and content cannot change.",
  };
}

export async function noticeReviewEvidence(id: string, lock = false) {
  if (lock) await lockCancellationNotice(prisma, id);
  const order = await prisma.ticketCancellationNotice.findUnique({
    where: { id },
  });
  if (!order)
    throw new ApiError("Original cancellation notice was not found", 404);
  const messages = await prisma.ticketDeliveryMessage.findMany({
    where: { cancellationNoticeId: id },
    orderBy: { id: "asc" },
  });
  return { order, messages };
}
/** The immutable notice intent and prior proof are fixed; claiming changes only work fields. */
export function noticeContentVersion({
  order,
  messages,
}: Awaited<ReturnType<typeof noticeReviewEvidence>>) {
  const {
    status,
    attemptId,
    attemptedAt,
    sentAt,
    error,
    updatedAt,
    ...intent
  } = order;
  return hashIntent({ intent, messages });
}
export function assertNoticeReview(
  evidence: Awaited<ReturnType<typeof noticeReviewEvidence>>,
  acknowledge: boolean,
  generation: string,
) {
  if (generation !== deliveryGeneration(evidence.order))
    throw new ApiError(
      "The original notice generation changed; prepare a fresh exact review",
      409,
    );
  const policy = deliveryDispatchPolicy(evidence);
  if (!policy.canRetry || (policy.duplicateRisk && !acknowledge))
    throw new ApiError(policy.reason, 409);
  if (!evidence.order.recipient)
    throw new ApiError(
      "The original notice has no recorded phone number. It cannot be redirected by a retry.",
      409,
    );
  if (
    evidence.order.attemptedAt &&
    Date.now() - evidence.order.attemptedAt.getTime() < 60000
  )
    throw new ApiError(
      "Please wait one minute before retrying the notice.",
      429,
    );
  return policy;
}

/** One read projection for list/detail; free-form content cannot bypass money grants. */
export function cancellationNoticeView(notice: TicketCancellationNotice) {
  const { recipient, content, ...visible } = notice;
  return { ...visible, recipientRecorded: !!recipient };
}
