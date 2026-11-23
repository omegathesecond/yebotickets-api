import type { Prisma } from "@prisma/client";

/** Return a supported scalar while holding the original purchase identity lock. */
export const lockPurchaseIdentity = (
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  key: string,
) =>
  client.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
