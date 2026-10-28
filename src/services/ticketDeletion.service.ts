import { Prisma } from '@prisma/client';
import { ApiError } from '../middleware/error.middleware';

/** Call with the event locked before any tier/ticket locks. Keep inventory that
 * anchors immutable purchase attempts, including failed attempts released back
 * to available: deleting a tier must never erase the event's purchase history. */
export const assertUnusedInventory = async (
  tx: Prisma.TransactionClient, eventId: string, ticketTypeId?: string
) => {
  const scope = ticketTypeId
    ? Prisma.sql`t."eventId" = ${eventId} AND t."ticketTypeId" = ${ticketTypeId}`
    : Prisma.sql`t."eventId" = ${eventId}`;
  const [result] = await tx.$queryRaw<{ history: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "Ticket" t WHERE ${scope} AND (
        t.status <> 'available' OR t."userId" IS NOT NULL OR
        t."purchaseDate" IS NOT NULL OR t."reservedAt" IS NOT NULL OR
        t."isCheckedIn" OR t."checkedInAt" IS NOT NULL OR
        t."paymentRef" IS NOT NULL OR t."paymentStatus" IS NOT NULL OR
        t."amountPaid" IS NOT NULL OR t."deliveryOrderId" IS NOT NULL OR
        t."refundRef" IS NOT NULL OR t."refundedAt" IS NOT NULL OR
        t."cancelledAt" IS NOT NULL OR t."refundRequestedAt" IS NOT NULL OR
        t."refundRequestReason" IS NOT NULL OR
        EXISTS (SELECT 1 FROM "TicketPurchaseAttempt" a WHERE t.id = ANY(a."ticketIds")) OR
        EXISTS (SELECT 1 FROM "TicketRefundLock" r WHERE r."ticketId" = t.id) OR
        EXISTS (SELECT 1 FROM "TicketAdmissionReceipt" r WHERE r."ticketId" = t.id)
      )
    ) OR EXISTS (
      SELECT 1 FROM "TicketAdmissionReceipt" r WHERE r."eventId" = ${eventId}
    ) AS history
  `);
  if (result.history) {
    throw new ApiError('Cannot delete event or ticket tier with purchase or admission history. Cancel or unpublish the event instead.', 409);
  }
};
