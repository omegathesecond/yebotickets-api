import { PrismaClient } from '@prisma/client';
import { createPrismaAdminScope } from '@omevision/product-admin-boundary/prisma';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

export const staffAdminScope = createPrismaAdminScope(basePrisma);
export const prisma = staffAdminScope.client;
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma;

export default prisma;
