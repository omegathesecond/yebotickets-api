import prisma, { staffAdminScope } from "../config/prisma";
import {
  CURRENCY,
  PLATFORM_SETTINGS_ID,
  assertPlatformFeePercent,
  getPlatformSettings,
} from "../config/platform";
import { ApiError } from "../middleware/error.middleware";
import type { Prisma } from "@prisma/client";

export const COMMISSION_POLICY =
  "Change the rate on eligible gross revenue not yet consumed by a payout. Reserved and paid payouts keep their original recorded fees, gross amounts and currency. No money is sent.";

export async function commissionChangeEvidence(
  id: string,
  feePercent: number,
  lock = false,
  client: Prisma.TransactionClient = prisma,
) {
  if (id !== PLATFORM_SETTINGS_ID)
    throw new ApiError("Choose the platform commission settings", 404);
  assertPlatformFeePercent(feePercent);
  const settings = await getPlatformSettings(
    client,
    lock ? "update" : undefined,
  );
  if (settings.feePercent === feePercent)
    throw new ApiError("Choose a different platform commission", 409);
  return settings;
}

export const platformSettingsView = async () => ({
  ...(await getPlatformSettings()),
  currency: CURRENCY,
  policy: COMMISSION_POLICY,
});

export const setPlatformCommission = async (id: string, feePercent: number) => {
  const actor = staffAdminScope.actor();
  if (!actor)
    throw new ApiError(
      "A verified corporate actor is required to change platform commission",
      401,
    );
  return prisma.$transaction(async (tx) => {
    await commissionChangeEvidence(id, feePercent, true, tx);
    return tx.platformSettings.update({
      where: { id },
      data: {
        feePercent,
        revision: { increment: 1 },
        updatedByStaff: actor.id,
      },
    });
  });
};
