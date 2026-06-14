-- AlterTable: persist a single-use, time-limited password-reset code on User.
-- The code columns are nullable so existing rows are unaffected; the attempts
-- counter defaults to 0 — a purely additive, backward-compatible change. The
-- code is cleared (set NULL) once a reset succeeds (single-use) or after too
-- many wrong guesses (brute-force cap).
ALTER TABLE "User" ADD COLUMN     "resetCode" TEXT,
ADD COLUMN     "resetCodeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetCodeAttempts" INTEGER NOT NULL DEFAULT 0;
