-- AlterTable: persist a single-use, time-limited password-reset code on User.
-- Both columns are nullable so existing rows are unaffected — this is a purely
-- additive, backward-compatible change. The code is cleared (set NULL) once a
-- reset succeeds, which is what makes it single-use.
ALTER TABLE "User" ADD COLUMN     "resetCode" TEXT,
ADD COLUMN     "resetCodeExpiresAt" TIMESTAMP(3);
