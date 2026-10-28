import type { Prisma } from '@prisma/client';
import { ApiError } from '../middleware/error.middleware';

// Call only while holding the event lock and before removing inventory.
export const assertNoTicketHistory = async (tx: Prisma.TransactionClient, eventId: string, ticketTypeId: string | null = null) => {
  const history = await tx.ticket.findFirst({
    where: {
      eventId,
      ...(ticketTypeId ? { ticketTypeId } : {}),
      OR: [
        { status: { not: 'available' } },
        { userId: { not: null } },
        { purchaseDate: { not: null } },
        { reservedAt: { not: null } },
        { paymentRef: { not: null } },
        { paymentStatus: { not: null } },
        { amountPaid: { not: null } },
        { deliveryOrderId: { not: null } },
        { refundRef: { not: null } },
        { refundedAt: { not: null } },
        { cancelledAt: { not: null } },
        { refundRequestedAt: { not: null } },
        { refundRequestReason: { not: null } },
        { isCheckedIn: true },
        { checkedInAt: { not: null } },
      ],
    },
    select: { id: true },
  });
  const receipt = await tx.ticketAdmissionReceipt.findFirst({ where: { eventId }, select: { opId: true } });
  // Refund locks deliberately have no FK; inspect them without loading
  // every generated ticket id into application memory or SQL parameters.
  const refunds = await tx.$queryRaw<{ chargeId: string }[]>`
    SELECT r."chargeId" FROM "TicketRefundLock" r
    JOIN "Ticket" t ON t."id" = r."ticketId"
    WHERE t."eventId" = ${eventId}
    AND (${ticketTypeId}::text IS NULL OR t."ticketTypeId" = ${ticketTypeId}) LIMIT 1
  `;
  // Failed/released purchases clear ticket fields but retain their durable
  // identity. Preserve those inventory rows too, including failed charges.
  const attempts = await tx.$queryRaw<{ key: string }[]>`
    SELECT a."key" FROM "TicketPurchaseAttempt" a
    JOIN "Ticket" t ON t."id" = ANY(a."ticketIds")
    WHERE t."eventId" = ${eventId}
    AND (${ticketTypeId}::text IS NULL OR t."ticketTypeId" = ${ticketTypeId}) LIMIT 1
  `;
  if (history || receipt || refunds.length || attempts.length) {
    throw new ApiError('Cannot delete an event with purchase or admission history. Cancel or unpublish the event instead.', 409);
  }
};
