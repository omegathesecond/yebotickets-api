import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import prisma from '../../config/prisma';
import { createEvent, updateEvent } from '../event.service';
import { createTicketType, updateTicketType } from '../ticket.service';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const date = (day: number) => new Date(Date.UTC(2030, 0, day));

// Emulate PostgreSQL's transaction-scoped row lock. The read must happen AFTER
// acquiring it; otherwise the opposing-update regression below fails.
let queue: Promise<void>;
let row: any;
let writes: number;
let transactionId: number;
const runUpdate = (tier: boolean, data: any) => tier
  ? updateTicketType('tier', data, 'owner') : updateEvent('event', data, 'owner');

beforeEach(() => {
  mockReset(db);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  queue = Promise.resolve();
  writes = 0;
  transactionId = 0;
  db.$transaction.mockImplementation((async (callback: any) => {
    const id = ++transactionId;
    let release: (() => void) | undefined;
    const tx = mockDeep<PrismaClient>();
    tx.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toMatch(/FOR UPDATE/);
      const previous = queue;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      return [{ id }];
    }) as any);
    tx.event.findFirst.mockImplementation((async () => ({ ...row, organizerId: 'owner' })) as any);
    tx.ticketType.findUnique.mockImplementation((async () => ({ ...row })) as any);
    const update = async ({ data }: any) => { writes++; row = { ...row, ...data }; return row; };
    tx.event.update.mockImplementation(update as any);
    tx.ticketType.update.mockImplementation(update as any);
    try { return await callback(tx); } finally { release?.(); }
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

for (const tier of [false, true]) {
  describe(tier ? 'ticket sale interval' : 'event interval', () => {
    const start = tier ? 'saleStartDate' : 'startDate';
    const end = tier ? 'saleEndDate' : 'endDate';
    beforeEach(() => {
      row = { id: tier ? 'tier' : 'event', eventId: 'event', type: 'standard', [start]: date(10), [end]: date(20) };
    });
    it.each([
      { [start]: date(15) }, { [end]: date(15) },
      { [start]: date(21), [end]: date(22) }, {},
      { [start]: date(10), [end]: date(20) },
    ])('preserves a valid effective pair: %p', async data => {
      await runUpdate(tier, data);
      expect(writes).toBe(1);
      expect(row[end].getTime()).toBeGreaterThan(row[start].getTime());
    });
    it.each([
      { [start]: date(21) }, { [end]: date(9) },
      { [start]: date(20) }, { [end]: date(10) },
      { [start]: date(22), [end]: date(21) },
      { [start]: date(15), [end]: date(15) },
      { [start]: 'invalid' }, { [end]: null },
    ])('rejects invalid effective dates without writing: %p', async data => {
      const before = { ...row };
      await expect(runUpdate(tier, data)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must be after') });
      expect(row).toEqual(before);
      expect(writes).toBe(0);
    });
    it('serializes opposing edits and rejects the second invalid pair', async () => {
      const results = await Promise.allSettled([
        runUpdate(tier, { [start]: date(18) }),
        runUpdate(tier, { [end]: date(12) }),
      ]);
      expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.statusCode).toBe(400);
      expect(writes).toBe(1);
      expect(row[end].getTime()).toBeGreaterThan(row[start].getTime());
    });
  });
}

it.each([[20, 10], [10, 10], [NaN, 20]])('rejects invalid service creation (%p, %p)', async (start, end) => {
  await expect(createEvent({ startDate: date(start), endDate: date(end) } as any, 'owner'))
    .rejects.toMatchObject({ statusCode: 400 });
  await expect(createTicketType({ saleStartDate: date(start), saleEndDate: date(end) }, 'event', 'owner'))
    .rejects.toMatchObject({ statusCode: 400 });
  expect(db.event.create).not.toHaveBeenCalled();
  expect(db.ticketType.create).not.toHaveBeenCalled();
});
