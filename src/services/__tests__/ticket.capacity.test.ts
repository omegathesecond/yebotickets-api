import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import prisma from '../../config/prisma';
import { generateTickets, updateTicketType } from '../ticket.service';

const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;

describe('ticket tier capacity', () => {
  let tier: any;
  let inventory: { status: string }[];
  let tail: Promise<void>;
  beforeEach(() => {
    mockReset(db);
    tier = { id: 'tier', eventId: 'event', quantity: 5, type: 'standard', saleStartDate: new Date('2030-01-01'), saleEndDate: new Date('2030-02-01') };
    inventory = [];
    tail = Promise.resolve();
    // Model PostgreSQL's row lock, acquired by the production SELECT FOR UPDATE.
    // A transaction that omits the lock will race at count/createMany below.
    db.$transaction.mockImplementation(async (callback: any) => {
      let release: (() => void) | undefined;
      const tx: any = {
        $queryRaw: jest.fn(async (sql: TemplateStringsArray, id: string) => {
          expect(sql.join('?')).toContain('FROM "TicketType" WHERE "id" = ? FOR UPDATE');
          expect(id).toBe('tier');
          const previous = tail;
          tail = new Promise<void>(resolve => { release = resolve; });
          await previous;
          return [{ id }];
        }),
        ticketType: {
          findUnique: jest.fn(async () => ({ ...tier })),
          update: jest.fn(async ({ data }: any) => { Object.assign(tier, data); return { ...tier }; }),
        },
        event: { findFirst: jest.fn(async () => ({ id: 'event' })) },
        ticket: {
          count: jest.fn(async (args: any) => {
            expect(args).toEqual({ where: { ticketTypeId: 'tier' } });
            const count = inventory.length;
            await Promise.resolve();
            return count;
          }),
          createMany: jest.fn(async ({ data }: any) => {
            inventory.push(...data);
            return { count: data.length };
          }),
        },
      };
      try { return await callback(tx); } finally { release?.(); }
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('rejects generating six tickets for a capacity of five without writes', async () => {
    await expect(generateTickets('tier', 6, 'owner')).rejects.toMatchObject({ statusCode: 400 });
    expect(inventory).toHaveLength(0);
  });

  it('generates initial inventory, then only remaining capacity; retries and excess do not write', async () => {
    await expect(generateTickets('tier', 3, 'owner')).resolves.toMatchObject({ count: 3 });
    await expect(generateTickets('tier', 3, 'owner')).rejects.toMatchObject({ statusCode: 400 });
    expect(inventory).toHaveLength(3);
    await expect(generateTickets('tier', 2, 'owner')).resolves.toMatchObject({ count: 2 });
    await expect(generateTickets('tier', 2, 'owner')).rejects.toThrow('remaining capacity is 0');
    expect(inventory).toHaveLength(5);
  });

  it('serializes competing generators so only one can fill the tier', async () => {
    const results = await Promise.allSettled([
      generateTickets('tier', 5, 'owner'), generateTickets('tier', 5, 'owner'),
    ]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(inventory).toHaveLength(5);
  });

  it('counts and preserves sold, reserved and cancelled tickets on capacity edits', async () => {
    inventory = ['sold', 'reserved', 'cancelled'].map(status => ({ status }));
    const original = [...inventory];
    await expect(updateTicketType('tier', { quantity: 2 }, 'owner')).rejects.toThrow('capacity exceeded');
    expect(tier.quantity).toBe(5);
    await updateTicketType('tier', { quantity: 3 }, 'owner');
    await expect(generateTickets('tier', 1, 'owner')).rejects.toThrow('capacity exceeded');
    await updateTicketType('tier', { quantity: 4 }, 'owner');
    await generateTickets('tier', 1, 'owner');
    expect(inventory.slice(0, 3)).toEqual(original);
  });

  it.each([true, false])('serializes generation and capacity reduction (generate first: %s)', async generateFirst => {
    const generate = () => generateTickets('tier', 5, 'owner');
    const reduce = () => updateTicketType('tier', { quantity: 2 }, 'owner');
    const results = await Promise.allSettled(generateFirst ? [generate(), reduce()] : [reduce(), generate()]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(inventory.length).toBeLessThanOrEqual(tier.quantity);
  });

  it.each([0, -1, 1.5, NaN])('rejects invalid generation quantity %s without writes', async quantity => {
    await expect(generateTickets('tier', quantity, 'owner')).rejects.toThrow('positive integer');
    expect(inventory).toHaveLength(0);
  });
});
