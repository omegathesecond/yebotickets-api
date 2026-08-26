-- Add the `approved` step to the payout lifecycle.
--
-- This lives in its OWN migration on purpose. Postgres refuses to USE a newly
-- added enum value in the same transaction that added it ("unsafe use of new
-- value ... New enum values must be committed before they can be used"), and
-- Prisma runs each migration file in one transaction. The next migration
-- references 'approved' in a partial index predicate, so the value has to be
-- committed by a transaction of its own first.
ALTER TYPE "PayoutRequestStatus" ADD VALUE IF NOT EXISTS 'approved' AFTER 'pending';
