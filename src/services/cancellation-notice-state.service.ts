import type { Prisma, TicketCancellationNotice } from "@prisma/client";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { CURRENCY } from "../config/platform";
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
  const notice = await prisma.ticketCancellationNotice.findUnique({
    where: { id },
  });
  if (!notice)
    throw new ApiError("Original cancellation notice was not found", 404);
  return {
    ...cancellationNoticeView(notice),
    note: "Financial completion and message delivery are separate. Sent records acceptance only. Unknown notices may already have been sent and are never automatically retried. The original recipient and content cannot change.",
  };
}

/** One read projection for list/detail; free-form content cannot bypass money grants. */
export function cancellationNoticeView(notice: TicketCancellationNotice) {
  const { recipient, content, ...visible } = notice;
  return { ...visible, recipientRecorded: !!recipient };
}
