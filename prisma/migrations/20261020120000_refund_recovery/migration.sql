ALTER TABLE "TicketRefundLock"
 ADD COLUMN "attemptId" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
 ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'REVIEW',
 ADD COLUMN "confirmedRef" TEXT,
 ADD COLUMN "detail" TEXT;
