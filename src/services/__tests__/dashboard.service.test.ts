import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getDashboardMetrics } from '../dashboard.service';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const NOW = new Date('2026-11-01T12:00:00Z');
const START = new Date('2026-10-02T12:00:00Z');
const PREVIOUS_START = new Date('2026-09-02T12:00:00Z');
const row = (purchaseDate: Date, amountPaid: number | null, price: number, status = 'sold') =>
  ({ purchaseDate, amountPaid, ticketType: { price }, status });

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  mockReset(db);
  db.event.count.mockResolvedValue(0);
  db.ticket.count.mockResolvedValue(0);
  db.user.count.mockResolvedValue(0);
});
afterEach(() => jest.useRealTimers());

// Apply the requested predicates so boundary/status regressions affect the result.
const useRows = (rows: ReturnType<typeof row>[]) => {
  db.ticket.findMany.mockImplementation(async (args: any) => {
    const { status, purchaseDate } = args.where;
    return rows.filter(t => t.status === status &&
      t.purchaseDate >= purchaseDate.gte &&
      (!purchaseDate.lt || t.purchaseDate < purchaseDate.lt)) as any;
  });
};

it('keeps both periods, trend and change stable after tier price edits; excludes non-sales', async () => {
  const rows = [
    row(START, 100, 100), row(NOW, 100, 100), row(NOW, 100, 100),
    row(NOW, 0, 0), row(PREVIOUS_START, 200, 200), row(PREVIOUS_START, 0, 0),
    row(NOW, 900, 900, 'reserved'), row(PREVIOUS_START, 900, 900, 'cancelled'),
    row(new Date(PREVIOUS_START.getTime() - 1), 900, 900),
  ];
  useRows(rows);
  const before = await getDashboardMetrics();
  expect(before.revenue).toEqual({ value: 300, trend: 'up', changePercent: 50, currency: 'KES' });
  rows.forEach(t => { t.ticketType.price = 2000; });
  expect((await getDashboardMetrics()).revenue).toEqual(before.revenue);
  expect(db.ticket.findMany).toHaveBeenNthCalledWith(1, {
    where: { status: 'sold', purchaseDate: { gte: START } },
    include: { ticketType: { select: { price: true } } },
  });
  expect(db.ticket.findMany).toHaveBeenNthCalledWith(2, {
    where: { status: 'sold', purchaseDate: { gte: PREVIOUS_START, lt: START } },
    include: { ticketType: { select: { price: true } } },
  });
});

it.each([
  [0, 100, 'down', -100],
  [100, 0, 'up', 100],
  [0, 0, 'neutral', 0],
  [100, 100, 'neutral', 0],
])('derives revenue from recorded amounts %s vs %s', async (current, previous, trend, changePercent) => {
  useRows([row(NOW, current, 999), row(PREVIOUS_START, previous, 999)]);
  expect((await getDashboardMetrics()).revenue).toMatchObject({ value: current, trend, changePercent });
});

it('uses shared missing-amount handling and rounds totals in both windows', async () => {
  useRows([
    row(NOW, null, 0.1), row(NOW, 0.2, 999),
    row(PREVIOUS_START, null, 0.1), row(PREVIOUS_START, 0.2, 999),
  ]);
  expect((await getDashboardMetrics()).revenue).toMatchObject({ value: 0.3, trend: 'neutral', changePercent: 0 });
});

it.each([1, 2])('propagates database failure in revenue window %s', async (window) => {
  const error = new Error('database unavailable');
  if (window === 2) db.ticket.findMany.mockResolvedValueOnce([]);
  db.ticket.findMany.mockRejectedValueOnce(error);
  await expect(getDashboardMetrics()).rejects.toBe(error);
});
