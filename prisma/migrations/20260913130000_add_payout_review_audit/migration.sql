-- Audit trail for admin decisions that gate real money movement:
-- WHO (which admin) approved/rejected an organizer for payouts, or
-- approved/rejected/marked-paid a payout request, and WHEN. Both columns are
-- nullable so existing rows (reviewed by no traced admin) are left as-is.

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "payoutApprovalReviewedByAdminId" TEXT,
  ADD COLUMN "payoutApprovalReviewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PayoutRequest"
  ADD COLUMN "reviewedByAdminId" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_payoutApprovalReviewedByAdminId_fkey" FOREIGN KEY ("payoutApprovalReviewedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
