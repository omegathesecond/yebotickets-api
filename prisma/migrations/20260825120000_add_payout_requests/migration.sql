-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('bank_transfer', 'mobile_money');

-- CreateEnum
CREATE TYPE "PayoutRequestStatus" AS ENUM ('pending', 'paid', 'rejected');

-- AlterTable: organizer payout-method details. All nullable/additive so
-- existing rows are unaffected; an organizer only fills these in once they
-- intend to request a withdrawal.
ALTER TABLE "User" ADD COLUMN     "payoutMethod" "PayoutMethod",
ADD COLUMN     "payoutBankName" TEXT,
ADD COLUMN     "payoutBankAccountName" TEXT,
ADD COLUMN     "payoutBankAccountNumber" TEXT,
ADD COLUMN     "payoutBankBranch" TEXT,
ADD COLUMN     "payoutMobileProvider" TEXT,
ADD COLUMN     "payoutMobileNumber" TEXT;

-- CreateTable
CREATE TABLE "PayoutRequest" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutRequestStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoutRequest_organizerId_idx" ON "PayoutRequest"("organizerId");

-- CreateIndex
CREATE INDEX "PayoutRequest_status_idx" ON "PayoutRequest"("status");

-- AddForeignKey
ALTER TABLE "PayoutRequest" ADD CONSTRAINT "PayoutRequest_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
