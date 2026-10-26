CREATE TABLE "TicketAdmissionReceipt" (
  "opId" TEXT NOT NULL PRIMARY KEY,
  "operatorId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
