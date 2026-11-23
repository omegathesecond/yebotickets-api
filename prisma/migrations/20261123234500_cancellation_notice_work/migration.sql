CREATE TABLE "TicketCancellationNotice" (
 "id" TEXT PRIMARY KEY,
 "ticketId" TEXT NOT NULL UNIQUE,
 "eventId" TEXT NOT NULL,
 "userId" TEXT,
 "ticketCode" TEXT NOT NULL,
 "eventTitle" TEXT NOT NULL,
 "recipient" TEXT,
 "refunded" BOOLEAN NOT NULL,
 "amount" DOUBLE PRECISION NOT NULL CHECK ("amount">=0 AND "amount"<'Infinity'::float8),
 "currency" TEXT NOT NULL,
 "refundAttemptId" TEXT UNIQUE,
 "refundGatewayRequestId" TEXT UNIQUE,
 "content" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','sending','sent','failed','unknown')),
 "attemptId" TEXT,
 "attemptedAt" TIMESTAMP(3),
 "sentAt" TIMESTAMP(3),
 "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "TicketCancellationNotice_financial_intent" CHECK (
  ("refunded" AND "amount">0 AND "refundAttemptId" IS NOT NULL AND "refundGatewayRequestId" IS NOT NULL)
  OR (NOT "refunded" AND "amount"=0 AND "refundAttemptId" IS NULL AND "refundGatewayRequestId" IS NULL)
 )
);
CREATE INDEX "TicketCancellationNotice_status_createdAt_idx" ON "TicketCancellationNotice" ("status","createdAt");
CREATE FUNCTION preserve_ticket_cancellation_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original ticket cancellation notice is immutable'; END IF;
 IF ROW(OLD.id,OLD."ticketId",OLD."eventId",OLD."userId",OLD."ticketCode",OLD."eventTitle",OLD.recipient,OLD.refunded,OLD.amount,OLD.currency,OLD."refundAttemptId",OLD."refundGatewayRequestId",OLD.content,OLD."createdAt") IS DISTINCT FROM
    ROW(NEW.id,NEW."ticketId",NEW."eventId",NEW."userId",NEW."ticketCode",NEW."eventTitle",NEW.recipient,NEW.refunded,NEW.amount,NEW.currency,NEW."refundAttemptId",NEW."refundGatewayRequestId",NEW.content,NEW."createdAt") THEN
  RAISE EXCEPTION 'Original ticket cancellation notice intent is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TicketCancellationNotice_preserve_original" BEFORE UPDATE OR DELETE ON "TicketCancellationNotice" FOR EACH ROW EXECUTE FUNCTION preserve_ticket_cancellation_notice();
ALTER TABLE "TicketDeliveryMessage" ALTER COLUMN "deliveryOrderId" DROP NOT NULL;
ALTER TABLE "TicketDeliveryMessage" ADD COLUMN "cancellationNoticeId" TEXT;
ALTER TABLE "TicketDeliveryMessage" ADD CONSTRAINT "TicketDeliveryMessage_exact_owner" CHECK (num_nonnulls("deliveryOrderId","cancellationNoticeId")=1);
CREATE INDEX "TicketDeliveryMessage_cancellationNoticeId_createdAt_idx" ON "TicketDeliveryMessage" ("cancellationNoticeId","createdAt");
CREATE OR REPLACE FUNCTION preserve_ticket_delivery_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original ticket delivery history is immutable'; END IF;
 IF ROW(OLD.id,OLD."deliveryOrderId",OLD."cancellationNoticeId",OLD."dispatchAttemptId",OLD.channel,OLD.recipient,OLD."createdAt") IS DISTINCT FROM
    ROW(NEW.id,NEW."deliveryOrderId",NEW."cancellationNoticeId",NEW."dispatchAttemptId",NEW.channel,NEW.recipient,NEW."createdAt") THEN
   RAISE EXCEPTION 'Original ticket delivery intent is immutable';
 END IF;
 IF OLD."messageId" IS NOT NULL AND ROW(OLD."messageId",OLD."acceptanceStatus",OLD.state) IS DISTINCT FROM ROW(NEW."messageId",NEW."acceptanceStatus",NEW.state) THEN
   RAISE EXCEPTION 'Original message acceptance is immutable';
 END IF;
 RETURN NEW;
END $$;
-- No backfill: old financial completion is not evidence that a notice was sent.
