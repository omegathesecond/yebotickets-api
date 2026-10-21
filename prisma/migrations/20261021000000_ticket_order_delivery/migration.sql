CREATE TABLE "TicketOrderDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "status" TEXT NOT NULL DEFAULT 'pending', "channel" TEXT, "error" TEXT,
 "attemptId" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "attemptedAt" TIMESTAMP(3), "sentAt" TIMESTAMP(3),
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "Ticket" ADD COLUMN "deliveryOrderId" TEXT;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_deliveryOrderId_fkey" FOREIGN KEY ("deliveryOrderId") REFERENCES "TicketOrderDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "TicketOrderDelivery_status_nextAttemptAt_idx" ON "TicketOrderDelivery"("status", "nextAttemptAt");
CREATE INDEX "Ticket_deliveryOrderId_idx" ON "Ticket"("deliveryOrderId");
