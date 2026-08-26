-- Clear orphaned payout schema left behind by an abandoned attempt.
--
-- A migration named `20260824120000_add_payouts` was applied straight to the
-- yebotickets dev and prod databases on 2026-08-24 but was never committed to
-- this repo. It created a `Payout` table, the `PayoutStatus` /
-- `PayoutMethodType` enums and four `User.payout*` columns, using a naming
-- scheme that no code in this repository has ever referenced — what actually
-- shipped is `PayoutRequest` plus `payoutBank*` / `payoutMobile*`
-- (20260825120000_add_payout_requests).
--
-- Those leftovers BLOCK that migration: `User.payoutMethod` and
-- `User.payoutBankName` already exist, so its ADD COLUMN fails and every
-- migration behind it — including the payout-requests table the deployed API
-- reads — never lands.
--
-- Verified empty before dropping: 0 rows in "Payout", all four User columns
-- NULL across every user row, and no foreign key anywhere referencing "Payout".
--
-- Every statement is IF EXISTS, so this is a no-op on a fresh database that
-- never saw the abandoned migration.

-- Columns first, so the enum drops below are not silently CASCADEd into a
-- column drop we did not intend.
ALTER TABLE "User"
  DROP COLUMN IF EXISTS "payoutMethod",
  DROP COLUMN IF EXISTS "payoutAccountName",
  DROP COLUMN IF EXISTS "payoutAccountNumber",
  DROP COLUMN IF EXISTS "payoutBankName";

DROP TABLE IF EXISTS "Payout";

-- Deliberately no CASCADE: if anything still depends on these types, this
-- fails loudly rather than quietly dropping whatever that is.
DROP TYPE IF EXISTS "PayoutStatus";
DROP TYPE IF EXISTS "PayoutMethodType";

-- Forget the abandoned migration itself. Its file does not exist in this repo
-- and everything it created is gone as of the statements above, so leaving the
-- row behind would make `prisma migrate status` report permanent phantom drift.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260824120000_add_payouts';
