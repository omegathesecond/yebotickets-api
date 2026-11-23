BEGIN;
CREATE TABLE "staff_admin_operations" (
 "id" UUID PRIMARY KEY, "actorId" TEXT NOT NULL, "method" TEXT NOT NULL, "path" TEXT NOT NULL,
 "requestHash" TEXT NOT NULL, "targetKey" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'running',
 "responseStatus" INTEGER, "responseBody" JSONB,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "staff_admin_operations_state" CHECK (state IN ('running','completed','failed','unknown'))
);
CREATE UNIQUE INDEX "staff_admin_operations_active_target" ON "staff_admin_operations"("targetKey") WHERE state IN ('running','unknown');

CREATE TABLE staff_admin_audit(id UUID PRIMARY KEY,"staffId" TEXT NOT NULL,"staffName" TEXT,"staffEmail" TEXT,operation TEXT NOT NULL,"targetKey" TEXT NOT NULL,parameters JSONB NOT NULL,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE "User" ADD COLUMN "payoutApprovalReviewedByStaff" TEXT;
ALTER TABLE "PayoutRequest" ADD COLUMN "reviewedByStaff" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_one_payout_reviewer" CHECK ("payoutApprovalReviewedByStaff" IS NULL OR "payoutApprovalReviewedByAdminId" IS NULL);
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_one_reviewer" CHECK ("reviewedByStaff" IS NULL OR "reviewedByAdminId" IS NULL);
COMMIT;
