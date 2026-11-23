import type { Prisma } from "@prisma/client";
import { createPostgresOperationStore } from "@omevision/product-admin-boundary";
import prisma from "../config/prisma";

export const operationStore = (
  client: Pick<Prisma.TransactionClient, "$queryRawUnsafe">,
) =>
  createPostgresOperationStore(async (query, values) => ({
    rows: await client.$queryRawUnsafe<any[]>(query, ...values),
  }));
export const staffOperationStore = operationStore(prisma);
