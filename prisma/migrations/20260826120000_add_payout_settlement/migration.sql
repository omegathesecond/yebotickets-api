-- Organizer settlement + payouts.
--
-- Purely ADDITIVE: nothing is dropped or renamed. `pending` keeps its meaning
-- ("requested"); `approved` is added to the enum by the preceding migration
-- (20260826115000) so it is committed before the partial index below uses it.
-- Existing rows keep working untouched.

-- AlterTable: settlement bookkeeping on each payout.
ALTER TABLE "PayoutRequest"
  ADD COLUMN "currency"    TEXT             NOT NULL DEFAULT 'SZL',
  ADD COLUMN "feePercent"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "feeAmount"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "grossAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "approvedAt"  TIMESTAMP(3),
  ADD COLUMN "paidAt"      TIMESTAMP(3),
  ADD COLUMN "reference"   TEXT,
  ADD COLUMN "destinationMethod"        "PayoutMethod",
  ADD COLUMN "destinationAccountName"   TEXT,
  ADD COLUMN "destinationAccountNumber" TEXT,
  ADD COLUMN "destinationBankName"      TEXT,
  ADD COLUMN "destinationDetail"        TEXT;

-- Backfill rows created before the fee existed: they were requested at a 0%
-- fee, so the gross ticket revenue they consumed equals the net amount.
UPDATE "PayoutRequest" SET "grossAmount" = "amount" WHERE "grossAmount" = 0;

-- Backfill the destination snapshot for in-flight requests from the
-- organizer's current payout details, so the admin queue keeps showing an
-- account for requests made before the snapshot columns existed.
UPDATE "PayoutRequest" p
SET "destinationMethod"        = u."payoutMethod",
    "destinationAccountName"   = COALESCE(u."payoutBankAccountName", u."name"),
    "destinationAccountNumber" = COALESCE(u."payoutBankAccountNumber", u."payoutMobileNumber"),
    "destinationBankName"      = u."payoutBankName",
    "destinationDetail"        = COALESCE(u."payoutBankBranch", u."payoutMobileProvider")
FROM "User" u
WHERE u."id" = p."organizerId"
  AND p."destinationMethod" IS NULL;

-- Backfill paidAt for rows already settled under the old two-state flow, so
-- historic payouts still report when the money moved.
UPDATE "PayoutRequest" SET "paidAt" = "processedAt"
WHERE "status" = 'paid' AND "paidAt" IS NULL AND "processedAt" IS NOT NULL;

-- At most ONE open (pending or approved) payout request per organizer.
--
-- The service also checks this so the caller gets a clear 409, but the check is
-- a read-then-write: two concurrent requests could both pass it and double-spend
-- the same balance. This partial unique index makes that race impossible at the
-- database. Prisma cannot express a partial unique index in schema.prisma, so it
-- lives here only — `prisma migrate dev` will report it as drift; keep it.
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutRequest_one_open_per_organizer"
  ON "PayoutRequest" ("organizerId")
  WHERE "status" IN ('pending', 'approved');
