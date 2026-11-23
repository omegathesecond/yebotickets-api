CREATE TABLE "PlatformSettings" (
  id UUID PRIMARY KEY CHECK (id = '00000000-0000-4000-8000-000000000001'),
  "feePercent" DOUBLE PRECISION NOT NULL CHECK ("feePercent" >= 0 AND "feePercent" < 100),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  "initializedFromRevision" TEXT NOT NULL,
  "updatedByStaff" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
-- No invented initial rate. Import the verified deployed rate with the reviewed
-- release bootstrap before this code serves traffic. Runtime never reads an env
-- fallback or silently creates settings when configuration is missing.
