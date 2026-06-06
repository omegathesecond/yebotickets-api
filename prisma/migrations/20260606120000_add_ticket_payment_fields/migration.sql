-- AlterTable: persist the YeboPay charge reference on a sold ticket.
-- All columns are nullable so existing rows (and any free/unsold tickets) are
-- unaffected — this is a purely additive, backward-compatible change.
ALTER TABLE "Ticket" ADD COLUMN     "paymentRef" TEXT,
ADD COLUMN     "paymentStatus" TEXT,
ADD COLUMN     "amountPaid" DOUBLE PRECISION;
