import type { Prisma } from "@prisma/client";

/** Hold one transaction-scoped source identity lock and return a supported scalar. */
export const lockTransactionIdentity = (
  client: Pick<Prisma.TransactionClient, "$queryRaw">,
  key: string,
) =>
  client.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
