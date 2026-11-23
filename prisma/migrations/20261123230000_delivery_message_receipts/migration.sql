CREATE TABLE "TicketDeliveryMessage" (
 "id" TEXT PRIMARY KEY,
 "deliveryOrderId" TEXT NOT NULL,
 "dispatchAttemptId" TEXT NOT NULL,
 "channel" TEXT NOT NULL CHECK ("channel" IN ('whatsapp','email')),
 "recipient" TEXT NOT NULL CHECK (length("recipient") > 0),
 "state" TEXT NOT NULL DEFAULT 'dispatching' CHECK ("state" IN ('dispatching','accepted','failed','unknown')),
 "messageId" TEXT UNIQUE,
 "acceptanceStatus" TEXT,
 "gatewayStatus" TEXT,
 "gatewayError" TEXT,
 "providerMessageId" TEXT,
 "gatewaySentAt" TIMESTAMP(3),
 "gatewayDeliveredAt" TIMESTAMP(3),
 "gatewayReadAt" TIMESTAMP(3),
 "gatewayFailedAt" TIMESTAMP(3),
 "error" TEXT,
 "checkedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "TicketDeliveryMessage_dispatchAttemptId_channel_key" UNIQUE ("dispatchAttemptId","channel"),
 CONSTRAINT "TicketDeliveryMessage_acceptance" CHECK (
  ("state"='accepted' AND "messageId" IS NOT NULL AND "acceptanceStatus" IS NOT NULL AND "gatewayStatus" IS NOT NULL)
  OR ("state"<>'accepted' AND "messageId" IS NULL AND "acceptanceStatus" IS NULL AND "gatewayStatus" IS NULL)
 )
);
CREATE INDEX "TicketDeliveryMessage_deliveryOrderId_createdAt_idx" ON "TicketDeliveryMessage" ("deliveryOrderId","createdAt");
CREATE FUNCTION preserve_ticket_delivery_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original ticket delivery history is immutable'; END IF;
 IF ROW(OLD.id,OLD."deliveryOrderId",OLD."dispatchAttemptId",OLD.channel,OLD.recipient,OLD."createdAt") IS DISTINCT FROM
    ROW(NEW.id,NEW."deliveryOrderId",NEW."dispatchAttemptId",NEW.channel,NEW.recipient,NEW."createdAt") THEN
   RAISE EXCEPTION 'Original ticket delivery intent is immutable';
 END IF;
 IF OLD."messageId" IS NOT NULL AND ROW(OLD."messageId",OLD."acceptanceStatus",OLD.state) IS DISTINCT FROM ROW(NEW."messageId",NEW."acceptanceStatus",NEW.state) THEN
   RAISE EXCEPTION 'Original message acceptance is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "TicketDeliveryMessage_preserve_original" BEFORE UPDATE OR DELETE ON "TicketDeliveryMessage" FOR EACH ROW EXECUTE FUNCTION preserve_ticket_delivery_message();
