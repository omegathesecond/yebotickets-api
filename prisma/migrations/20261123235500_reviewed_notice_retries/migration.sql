CREATE OR REPLACE FUNCTION preserve_corporate_refund_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.operation IN ('admin_refund_ticket','admin_cancel_event','admin_recover_purchase','admin_retry_delivery','admin_retry_cancellation_notice') THEN RAISE EXCEPTION 'Original corporate effect intent is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP INDEX staff_admin_original_delivery_attempt;
CREATE UNIQUE INDEX staff_admin_original_message_attempt ON staff_admin_audit ((parameters->'reviewedEffect'->>'dispatchAttemptId')) WHERE operation IN ('admin_retry_delivery','admin_retry_cancellation_notice');
ALTER TABLE "TicketCancellationNotice" DROP CONSTRAINT "TicketCancellationNotice_status_check";
ALTER TABLE "TicketCancellationNotice" ADD CONSTRAINT "TicketCancellationNotice_status_check" CHECK ("status" IN ('pending','sending','sent','failed','unknown','suppressed'));
