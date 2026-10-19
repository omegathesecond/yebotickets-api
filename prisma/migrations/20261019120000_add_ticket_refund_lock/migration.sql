CREATE TABLE "TicketRefundLock" (
    "chargeId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "refundedBefore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TicketRefundLock_pkey" PRIMARY KEY ("chargeId")
);
