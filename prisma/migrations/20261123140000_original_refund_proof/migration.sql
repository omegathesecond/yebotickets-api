BEGIN;
ALTER TABLE "Ticket" ADD COLUMN "refundAttemptId" TEXT, ADD COLUMN "refundGatewayRequestId" TEXT;
CREATE UNIQUE INDEX "Ticket_refundAttemptId_key" ON "Ticket"("refundAttemptId");
CREATE UNIQUE INDEX "Ticket_refundGatewayRequestId_key" ON "Ticket"("refundGatewayRequestId");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_completed_refund_proof" CHECK ("refundAttemptId" IS NULL OR ("paymentStatus" IS NOT NULL AND "paymentStatus"='REFUNDED' AND status='cancelled' AND "refundGatewayRequestId" IS NOT NULL AND LENGTH("refundGatewayRequestId")>0 AND "refundRef" IS NOT NULL AND LENGTH("refundRef")>0 AND "refundedAt" IS NOT NULL));
ALTER TABLE "TicketRefundLock" ADD COLUMN "gatewayRequestId" TEXT;

-- Existing historical rows are not assigned invented gateway identities.
-- A current intent's identity/amount and captured proof are immutable.
CREATE FUNCTION enforce_ticket_refund_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW."chargeId",NEW."ticketId",NEW."attemptId",NEW.amount,NEW."createdAt") IS DISTINCT FROM ROW(OLD."chargeId",OLD."ticketId",OLD."attemptId",OLD.amount,OLD."createdAt") THEN RAISE EXCEPTION 'Original ticket refund intent is immutable';END IF;
 IF OLD."refundedBefore" IS NOT NULL AND NEW."refundedBefore" IS DISTINCT FROM OLD."refundedBefore" THEN RAISE EXCEPTION 'Original refund starting amount is immutable';END IF;
 IF OLD."gatewayRequestId" IS NOT NULL AND NEW."gatewayRequestId" IS DISTINCT FROM OLD."gatewayRequestId" THEN RAISE EXCEPTION 'Original gateway refund identity is immutable';END IF;
 IF OLD."confirmedRef" IS NOT NULL AND NEW."confirmedRef" IS DISTINCT FROM OLD."confirmedRef" THEN RAISE EXCEPTION 'Original provider refund reference is immutable';END IF;
 IF OLD.phase='CONFIRMED' AND NEW.phase IS DISTINCT FROM OLD.phase THEN RAISE EXCEPTION 'A confirmed refund cannot regress';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "TicketRefundLock_identity" BEFORE UPDATE ON "TicketRefundLock" FOR EACH ROW EXECUTE FUNCTION enforce_ticket_refund_identity();
CREATE FUNCTION enforce_completed_ticket_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."refundAttemptId" IS NOT NULL AND ROW(NEW."refundAttemptId",NEW."refundGatewayRequestId",NEW."refundRef",NEW."paymentRef",NEW."amountPaid",NEW."paymentStatus",NEW.status,NEW."refundedAt") IS DISTINCT FROM ROW(OLD."refundAttemptId",OLD."refundGatewayRequestId",OLD."refundRef",OLD."paymentRef",OLD."amountPaid",OLD."paymentStatus",OLD.status,OLD."refundedAt") THEN RAISE EXCEPTION 'Completed ticket refund proof is immutable';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER "Ticket_completed_refund" BEFORE UPDATE ON "Ticket" FOR EACH ROW EXECUTE FUNCTION enforce_completed_ticket_refund();
COMMIT;
