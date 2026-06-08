-- AlterTable: timestamp marking when a Ticket entered the 'reserved' hold.
-- Nullable + no default so existing rows are unaffected (purely additive,
-- backward-compatible). Set on every reserve, cleared on release/finalize.
-- Drives TTL reclamation of reservations whose async (mobile-money PENDING)
-- charge never confirms, so inventory is never stranded reserved forever.
ALTER TABLE "Ticket" ADD COLUMN     "reservedAt" TIMESTAMP(3);
