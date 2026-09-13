-- Buyer self-service refund request: intent only, does not move money. Set by
-- POST /api/tickets/:ticketId/refund-request; cleared by the existing
-- organizer/admin refund endpoint once it actually refunds the ticket.
ALTER TABLE "Ticket"
  ADD COLUMN "refundRequestedAt" TIMESTAMP(3),
  ADD COLUMN "refundRequestReason" TEXT;
