-- Existing receipts belong to actual product operators. Corporate staff are
-- separately namespaced actors, never manufactured User identities.
ALTER TABLE "TicketAdmissionReceipt" ADD COLUMN "operatorKind" TEXT NOT NULL DEFAULT 'PRODUCT';
ALTER TABLE "TicketAdmissionReceipt" ADD CONSTRAINT "TicketAdmissionReceipt_operatorKind_check" CHECK ("operatorKind" IN ('PRODUCT','CORPORATE'));
