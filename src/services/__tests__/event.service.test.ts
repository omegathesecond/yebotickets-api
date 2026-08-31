import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Replace the prisma singleton (default export of ../config/prisma) with a deep
// jest mock so getEvents' query is inspected without touching a database.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getEvents, getEventById } from '../event.service';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
  // getEvents runs findMany + count together via prisma.$transaction([...]);
  // the array form just needs its member promises awaited, same as real Prisma.
  prismaMock.$transaction.mockImplementation(((ops: any[]) => Promise.all(ops)) as any);
  prismaMock.event.count.mockResolvedValue(0);
});

const buildEventRow = (over: Partial<any> = {}) => ({
  id: 'event-1',
  title: 'Test Fest',
  description: 'A test event',
  locationAddress: '1 Main St',
  locationCity: 'Mbabane',
  locationCountry: 'Eswatini',
  locationLat: null,
  locationLng: null,
  startDate: new Date('2026-07-01T18:00:00Z'),
  endDate: new Date('2026-07-01T23:00:00Z'),
  organizerId: 'org-1',
  organizer: { id: 'org-1', name: 'Org', email: 'org@example.com' },
  isPublished: true,
  isCancelled: false,
  cancelledAt: null,
  coverImage: null,
  category: 'music',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('getEvents — cancelled events excluded from listings', () => {
  it('excludes cancelled events by default (where.isCancelled === false)', async () => {
    prismaMock.event.findMany.mockResolvedValue([buildEventRow()] as any);

    await getEvents({});

    const arg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(arg.where.isCancelled).toBe(false);
    // Default also still scopes to published events.
    expect(arg.where.isPublished).toBe(true);
  });

  it('includes cancelled events only when showCancelled=true is passed', async () => {
    prismaMock.event.findMany.mockResolvedValue([] as any);

    await getEvents({ showCancelled: 'true' });

    const arg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(arg.where.isCancelled).toBeUndefined();
  });
});

describe('transformEvent — surfaces cancellation state', () => {
  it('exposes isCancelled/cancelledAt so a client can show a dead event', async () => {
    const cancelledAt = new Date('2026-06-06T13:00:00Z');
    prismaMock.event.findUnique.mockResolvedValue(
      buildEventRow({ isCancelled: true, cancelledAt, ticketTypes: [] }) as any
    );

    // A cancelled event now 404s for an unauthenticated caller (see
    // event.controller.publicById.test.ts); fetch as the owning organizer so
    // this test can still assert on the transform's cancellation fields.
    const event = await getEventById('event-1', { id: 'org-1', role: 'organizer' });

    expect(event.isCancelled).toBe(true);
    expect(event.cancelledAt).toEqual(cancelledAt);
  });

  it('defaults isCancelled to false for a live event', async () => {
    prismaMock.event.findMany.mockResolvedValue([buildEventRow()] as any);

    const { data: [event] } = await getEvents({});

    expect(event.isCancelled).toBe(false);
    expect(event.cancelledAt).toBeNull();
  });
});

describe('getEvents — upcoming-only default', () => {
  it('filters to endDate >= now by default (no includePast)', async () => {
    prismaMock.event.findMany.mockResolvedValue([]);

    const before = new Date();
    await getEvents({});
    const after = new Date();

    const findManyArg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(findManyArg.where.endDate.gte.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(findManyArg.where.endDate.gte.getTime()).toBeLessThanOrEqual(after.getTime());

    const countArg = prismaMock.event.count.mock.calls[0][0] as any;
    expect(countArg.where.endDate.gte).toBeInstanceOf(Date);
  });

  it('does not filter by endDate when includePast=true', async () => {
    prismaMock.event.findMany.mockResolvedValue([]);

    await getEvents({ includePast: 'true' });

    const findManyArg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(findManyArg.where.endDate).toBeUndefined();
  });

  it('a past event is not returned by default, but is returned with includePast=true', async () => {
    const pastEvent = buildEventRow({
      id: 'past-event',
      startDate: new Date('2020-01-01T00:00:00Z'),
      endDate: new Date('2020-01-02T00:00:00Z'),
    });

    // Stand in for the database honoring the where clause: the past event
    // only comes back when the query has no endDate floor.
    prismaMock.event.findMany.mockImplementation(((args: any) =>
      Promise.resolve(args.where.endDate ? [] : [pastEvent])
    ) as any);
    prismaMock.event.count.mockImplementation(((args: any) =>
      Promise.resolve(args.where.endDate ? 0 : 1)
    ) as any);

    const defaultResult = await getEvents({});
    expect(defaultResult.data.map((e: any) => e.id)).not.toContain('past-event');

    const includePastResult = await getEvents({ includePast: 'true' });
    expect(includePastResult.data.map((e: any) => e.id)).toContain('past-event');
  });
});

describe('getEvents — pagination', () => {
  it('returns page metadata and never repeats rows across pages', async () => {
    const page1Rows = [buildEventRow({ id: 'e1' }), buildEventRow({ id: 'e2' })];
    const page2Rows = [buildEventRow({ id: 'e3' })];

    prismaMock.event.findMany.mockImplementation(((args: any) =>
      Promise.resolve(args.skip === 0 ? page1Rows : page2Rows)
    ) as any);
    prismaMock.event.count.mockResolvedValue(3);

    const page1 = await getEvents({ limit: '2', page: '1' });
    expect(page1.data.map((e: any) => e.id)).toEqual(['e1', 'e2']);
    expect(page1.total).toBe(3);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page2 = await getEvents({ limit: '2', page: '2' });
    expect(page2.data.map((e: any) => e.id)).toEqual(['e3']);
    expect(page2.total).toBe(3);
    expect(page2.page).toBe(2);
    expect(page2.hasMore).toBe(false);

    const page1Ids = page1.data.map((e: any) => e.id);
    const page2Ids = page2.data.map((e: any) => e.id);
    expect(page1Ids.some((id: string) => page2Ids.includes(id))).toBe(false);

    const findManyCalls = prismaMock.event.findMany.mock.calls as any[];
    expect(findManyCalls[0][0].skip).toBe(0);
    expect(findManyCalls[0][0].take).toBe(2);
    expect(findManyCalls[1][0].skip).toBe(2);
    expect(findManyCalls[1][0].take).toBe(2);
  });

  it('reflects the full match count in total, not the page size', async () => {
    prismaMock.event.findMany.mockResolvedValue([buildEventRow()] as any);
    prismaMock.event.count.mockResolvedValue(137);

    const result = await getEvents({ limit: '2' });

    expect(result.data.length).toBe(1);
    expect(result.total).toBe(137);
  });

  it('clamps an oversized limit and defaults page to 1', async () => {
    prismaMock.event.findMany.mockResolvedValue([]);

    const result = await getEvents({ limit: '9999' });

    expect(result.page).toBe(1);
    expect(result.limit).toBeLessThanOrEqual(100);

    const findManyArg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(findManyArg.take).toBe(result.limit);
    expect(findManyArg.skip).toBe(0);
  });
});
