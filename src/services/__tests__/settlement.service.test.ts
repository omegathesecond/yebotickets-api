import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Replace the prisma singleton with a deep mock so the settlement calculation
// can be exercised against hand-built ticket/event rows without a database.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getOrganizerStatement, splitPayoutFee } from '../settlement.service';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

/** Fixed "now" so the finished-vs-upcoming boundary is deterministic. */
const NOW = new Date('2026-08-26T12:00:00Z');
const FINISHED = new Date('2026-08-01T23:00:00Z');
const UPCOMING = new Date('2026-12-01T23:00:00Z');

const ORG = 'org-1';

const originalFeePercent = process.env.PLATFORM_FEE_PERCENT;

const setFee = (value?: string) => {
  if (value === undefined) delete process.env.PLATFORM_FEE_PERCENT;
  else process.env.PLATFORM_FEE_PERCENT = value;
};

const event = (id: string, endDate: Date, over: Partial<any> = {}) => ({
  id,
  title: `Event ${id}`,
  endDate,
  isCancelled: false,
  ...over,
});

/** A ticket row as the settlement query selects it. `amountPaid` is what YeboPay
 *  actually charged; `price` is the ticket type's list price. */
const ticket = (
  eventId: string,
  status: 'sold' | 'cancelled',
  amountPaid: number | null,
  price = 0
) => ({ eventId, status, amountPaid, ticketType: { price } });

/** Wire the two reads the statement makes, plus payout aggregates. `paid`/
 *  `reserved` may be a plain net amount (grossAmount/feeAmount default to 0,
 *  matching legacy rows) or a full frozen split as `splitPayoutFee` produces. */
const wire = (
  events: any[],
  tickets: any[],
  payouts: {
    paid?: number | { amount: number; grossAmount: number; feeAmount: number };
    reserved?: number | { amount: number; grossAmount: number; feeAmount: number };
  } = {}
) => {
  const normalize = (v: number | { amount: number; grossAmount: number; feeAmount: number } | undefined) =>
    typeof v === 'number' ? { amount: v, grossAmount: 0, feeAmount: 0 } : v ?? { amount: 0, grossAmount: 0, feeAmount: 0 };

  const paid = normalize(payouts.paid);
  const reserved = normalize(payouts.reserved);

  prismaMock.event.findMany.mockResolvedValue(events as any);
  prismaMock.ticket.findMany.mockResolvedValue(tickets as any);
  prismaMock.payoutRequest.aggregate.mockImplementation((async (args: any) => {
    const status = args.where.status;
    const isPaidQuery = status === 'paid';
    const { amount, grossAmount, feeAmount } = isPaidQuery ? paid : reserved;
    return { _sum: { amount, grossAmount, feeAmount } };
  }) as any);
};

beforeEach(() => {
  mockReset(prismaMock);
  setFee(undefined);
});

afterAll(() => {
  setFee(originalFeePercent);
});

describe('getOrganizerStatement — what the organizer is owed', () => {
  it('derives gross sales from what was actually charged, not the list price', async () => {
    // A ticket discounted at checkout: charged 60 against a list price of 100.
    // Settling on list price would pay out money the platform never collected.
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 60, 100)]);

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.grossSales).toBe(60);
    expect(statement.availableBalance).toBe(60);
  });

  it('falls back to the list price only for legacy rows with no recorded charge', async () => {
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', null, 100)]);

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.grossSales).toBe(100);
  });

  it('EXCLUDES refunded/cancelled tickets from the available balance', async () => {
    // Both rows come back from the same query; only the sold one is the
    // organizer's money. The refunded one went back to the buyer.
    wire(
      [event('e1', FINISHED)],
      [ticket('e1', 'sold', 100), ticket('e1', 'cancelled', 250)]
    );

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.grossSales).toBe(100);
    expect(statement.refundedSales).toBe(250);
    expect(statement.availableBalance).toBe(100);
    expect(statement.events[0].refundedSales).toBe(250);
  });

  it('HOLDS BACK sales for an event that has not finished yet', async () => {
    // The upcoming event could still be cancelled, which would refund its
    // buyers out of the platform's account — so its money is not withdrawable.
    wire(
      [event('past', FINISHED), event('future', UPCOMING)],
      [ticket('past', 'sold', 100), ticket('future', 'sold', 400)]
    );

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.grossSales).toBe(500);
    expect(statement.eligibleGross).toBe(100);
    expect(statement.pendingSales).toBe(400);
    expect(statement.availableBalance).toBe(100);

    const future = statement.events.find((e) => e.eventId === 'future');
    expect(future?.eligible).toBe(false);
    expect(future?.holdReason).toBe('Event has not finished yet');
  });

  it('holds back sales for a cancelled event even once its date has passed', async () => {
    wire(
      [event('cancelled', FINISHED, { isCancelled: true })],
      [ticket('cancelled', 'sold', 300)]
    );

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.availableBalance).toBe(0);
    expect(statement.events[0].holdReason).toBe('Event was cancelled');
  });

  it('SUBTRACTS the platform fee from what may be withdrawn', async () => {
    setFee('10');
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 1000)]);

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.feePercent).toBe(10);
    expect(statement.grossSales).toBe(1000);
    expect(statement.platformFee).toBe(100);
    expect(statement.netEarned).toBe(900);
    expect(statement.availableBalance).toBe(900);
  });

  it('charges no fee when PLATFORM_FEE_PERCENT is unset (unchanged behaviour)', async () => {
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 1000)]);

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.feePercent).toBe(0);
    expect(statement.platformFee).toBe(0);
    expect(statement.availableBalance).toBe(1000);
  });

  it('THROWS on a misconfigured fee rather than silently treating it as 0%', async () => {
    setFee('not-a-number');
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 1000)]);

    await expect(getOrganizerStatement(ORG, NOW)).rejects.toThrow(/PLATFORM_FEE_PERCENT/);
  });

  it('subtracts money already paid out and money reserved by an open request', async () => {
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 1000)], { paid: 300, reserved: 200 });

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.paidOut).toBe(300);
    expect(statement.reserved).toBe(200);
    expect(statement.availableBalance).toBe(500);
  });

  it('never reports a negative balance', async () => {
    wire([event('e1', FINISHED)], [ticket('e1', 'sold', 100)], { paid: 500 });

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.availableBalance).toBe(0);
  });

  it('does NOT retro-charge a payout already settled at a different fee rate', async () => {
    // Organizer earned 1000 while the fee was 0%, requested it all, and it was
    // PAID — frozen as amount 1000 / feePercent 0 / feeAmount 0 / grossAmount
    // 1000 (splitPayoutFee's own math). Only afterwards does the business turn
    // the fee on. A second event then sells another 500 of eligible gross that
    // was NEVER part of that payout.
    setFee('10');
    wire(
      [event('paid-out', FINISHED), event('new', FINISHED)],
      [ticket('paid-out', 'sold', 1000), ticket('new', 'sold', 500)],
      { paid: { amount: 1000, grossAmount: 1000, feeAmount: 0 } }
    );

    const statement = await getOrganizerStatement(ORG, NOW);

    // The 1000 already paid out must not be re-taxed at 10% now that the rate
    // changed — only the fresh 500 gross is fee'd at the current rate.
    expect(statement.eligibleGross).toBe(1500);
    expect(statement.platformFee).toBe(50);
    expect(statement.netEarned).toBe(1450);
    expect(statement.paidOut).toBe(1000);
    expect(statement.availableBalance).toBe(450);
  });

  it('returns an empty statement for an organizer with no events', async () => {
    wire([], []);

    const statement = await getOrganizerStatement(ORG, NOW);

    expect(statement.grossSales).toBe(0);
    expect(statement.availableBalance).toBe(0);
    expect(statement.events).toEqual([]);
    // No events means no ticket lookup at all.
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('splitPayoutFee — freezing the fee on a payout row', () => {
  it('records a zero fee when the platform takes no commission', () => {
    expect(splitPayoutFee(500, 0)).toEqual({
      amount: 500,
      feePercent: 0,
      feeAmount: 0,
      grossAmount: 500,
    });
  });

  it('grosses a net amount back up to the ticket revenue it consumed', () => {
    // At 10%, a net 900 to the organizer came out of 1000 of ticket sales.
    expect(splitPayoutFee(900, 10)).toEqual({
      amount: 900,
      feePercent: 10,
      feeAmount: 100,
      grossAmount: 1000,
    });
  });
});
