-- AlterTable: track consecutive failed verify-otp attempts per user.
-- NOT NULL with a 0 default so existing rows backfill cleanly (purely additive,
-- backward-compatible). Reset to 0 on new OTP issuance and on successful
-- verification; when it reaches the lockout threshold the OTP is invalidated to
-- stop brute-forcing the 6-digit code.
ALTER TABLE "User" ADD COLUMN     "otpAttempts" INTEGER NOT NULL DEFAULT 0;
