-- AlterTable: event-level cancellation flag + timestamp. Both default/nullable
-- so existing events are unaffected — purely additive, backward-compatible.
ALTER TABLE "Event" ADD COLUMN     "isCancelled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable: persist the refund / cancellation outcome on a ticket. All
-- nullable so existing rows are unaffected. A sold ticket flips to CANCELLED
-- with paymentStatus=REFUNDED and these fields set only after YeboPay confirms
-- the refund; free tickets are cancelled with cancelledAt set and no refundRef.
ALTER TABLE "Ticket" ADD COLUMN     "refundRef" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "cancelledAt" TIMESTAMP(3);
