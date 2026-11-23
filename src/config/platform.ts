import type { Prisma } from "@prisma/client";
import prisma from "./prisma";
import { ApiError } from "../middleware/error.middleware";

/** Canonical source money settings; database failures never become a 0% fee. */
export const PLATFORM_SETTINGS_ID = "00000000-0000-4000-8000-000000000001";

/** Currency every ticket is priced and charged in (Eswatini lilangeni). */
export const CURRENCY = "SZL";

export const assertPlatformFeePercent = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value >= 100
  )
    throw new ApiError(
      "Platform commission must be a number from 0 up to, but below, 100 percent",
      400,
    );
  return value;
};

export const getPlatformSettings = async (
  client: Prisma.TransactionClient = prisma,
  lock?: "share" | "update",
) => {
  if (lock === "share")
    await client.$queryRaw`SELECT id FROM "PlatformSettings" WHERE id=${PLATFORM_SETTINGS_ID}::uuid FOR SHARE`;
  if (lock === "update")
    await client.$queryRaw`SELECT id FROM "PlatformSettings" WHERE id=${PLATFORM_SETTINGS_ID}::uuid FOR UPDATE`;
  const settings = await client.platformSettings.findUnique({
    where: { id: PLATFORM_SETTINGS_ID },
  });
  if (!settings)
    throw new ApiError(
      "Platform commission is not configured. Complete the reviewed settings import before serving traffic.",
      503,
    );
  assertPlatformFeePercent(settings.feePercent);
  return settings;
};

export const getPlatformFeePercent = async (
  client: Prisma.TransactionClient = prisma,
): Promise<number> => (await getPlatformSettings(client)).feePercent;

/** Round a money figure to 2dp, killing float drift (0.1 + 0.2 === 0.30000000000000004). */
export const roundMoney = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;
