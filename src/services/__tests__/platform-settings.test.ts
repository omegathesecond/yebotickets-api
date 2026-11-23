import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import prisma from '../../config/prisma';
import { getPlatformFeePercent, assertPlatformFeePercent } from '../../config/platform';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
beforeEach(() => mockReset(db));
it('refuses missing database settings even when the retired environment variable is present', async () => {
  const previous = process.env.PLATFORM_FEE_PERCENT;
  process.env.PLATFORM_FEE_PERCENT = '42';
  db.platformSettings.findUnique.mockResolvedValue(null);
  try { await expect(getPlatformFeePercent()).rejects.toMatchObject({ statusCode: 503 }); }
  finally {
    if (previous === undefined) delete process.env.PLATFORM_FEE_PERCENT;
    else process.env.PLATFORM_FEE_PERCENT = previous;
  }
});
it('propagates database outages instead of inventing a rate', async () => {
  db.platformSettings.findUnique.mockRejectedValue(new Error('Fixture database unavailable'));
  await expect(getPlatformFeePercent()).rejects.toThrow('Fixture database unavailable');
});
it.each([NaN, Infinity, -1, 100, '10', null, undefined])('rejects invalid commission %p', value => {
  expect(() => assertPlatformFeePercent(value)).toThrow('Platform commission');
});
it.each([0, 10.5, 99.99])('uses an explicitly stored commission %p', async feePercent => {
  db.platformSettings.findUnique.mockResolvedValue({ feePercent } as any);
  await expect(getPlatformFeePercent()).resolves.toBe(feePercent);
});
