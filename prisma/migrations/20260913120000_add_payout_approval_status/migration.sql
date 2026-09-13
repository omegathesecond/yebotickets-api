-- Staff review gate in front of createPayoutRequest, separate from the
-- auto-set phone-OTP `isVerified` flag. Brand-new enum (not an ADD VALUE on an
-- existing one), so it is safe to create and use in the same transaction.
-- CreateEnum
CREATE TYPE "PayoutApprovalStatus" AS ENUM ('unreviewed', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "payoutApprovalStatus" "PayoutApprovalStatus" NOT NULL DEFAULT 'unreviewed';

-- Backfill: organizers that already existed before this gate shipped are
-- already trusted (publishing paid events, some already paid out) — do not
-- retroactively lock them out of withdrawing. Only NEW organizer signups
-- after this migration start `unreviewed`.
UPDATE "User" SET "payoutApprovalStatus" = 'approved' WHERE "role" = 'organizer';
