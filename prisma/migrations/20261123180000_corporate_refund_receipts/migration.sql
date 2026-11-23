BEGIN;
ALTER TABLE "TicketRefundLock" ADD COLUMN "corporateOperationId" UUID UNIQUE REFERENCES staff_admin_operations(id);
CREATE UNIQUE INDEX "TicketRefundLock_attemptId_key" ON "TicketRefundLock"("attemptId");
ALTER TABLE "TicketRefundLock" ADD CONSTRAINT "TicketRefundLock_corporate_attempt" CHECK ("corporateOperationId" IS NULL OR "corporateOperationId"::text="attemptId");
CREATE FUNCTION preserve_corporate_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."corporateOperationId" IS DISTINCT FROM OLD."corporateOperationId" THEN RAISE EXCEPTION 'Original corporate refund association is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_corporate_ticket_refund BEFORE UPDATE ON "TicketRefundLock" FOR EACH ROW EXECUTE FUNCTION preserve_corporate_ticket_refund();
CREATE FUNCTION preserve_corporate_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation='admin_refund_ticket' THEN RAISE EXCEPTION 'Original corporate refund intent is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER preserve_corporate_refund_audit BEFORE UPDATE OR DELETE ON staff_admin_audit FOR EACH ROW EXECUTE FUNCTION preserve_corporate_refund_audit();
COMMIT;
