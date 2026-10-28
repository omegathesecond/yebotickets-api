CREATE TABLE "TicketPurchaseAttempt" (
 "key" TEXT PRIMARY KEY,
 "userId" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL,
 "ticketIds" TEXT[] NOT NULL,
 "attemptRef" TEXT NOT NULL,
 "chargeId" TEXT,
 "failure" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "TicketPurchaseAttempt_attemptRef_key" ON "TicketPurchaseAttempt"("attemptRef");
CREATE UNIQUE INDEX "TicketPurchaseAttempt_chargeId_key" ON "TicketPurchaseAttempt"("chargeId");
