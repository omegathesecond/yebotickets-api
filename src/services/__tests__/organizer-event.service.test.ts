import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Replace the prisma singleton with a deep mock so the organizer-dashboard read
// models can be exercised (ownership rules, real-ticket-derived money) without a
// database.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import {
  assertEventAccess,
  getOrganizerEarnings,
  getEventDetailsForOrganizer,
  getEventPurchases,
  getEventTickets,
  getOrganizerDashboardStats,
  getOrganizerMonthlyStats,
  getOrganizerRecentActivity,
} from '../organizer-event.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
});

const eventRow = (over: Partial<any> = {}) => ({
  id: 'event-1',
  title: 'Test Fest',
  description: 'A test event',
  locationAddress: '1 Main St',
  locationCity: 'Mbabane',
  locationCountry: 'Eswatini',
  startDate: new Date('2026-07-01T18:00:00Z'),
  endDate: new Date('2026-07-01T23:00:00Z'),
  organizerId: 'org-1',
  isPublished: true,
  isCancelled: false,
  coverImage: null,
  category: 'music',
  ticketTypes: [{ id: 'tt-1', name: 'VIP', price: 100, quantity: 50 }],
  ...over,
});

describe('assertEventAccess — ownership enforcement', () => {
  it('throws 404 when the event does not exist', async () => {
    prismaMock.event.findUnique.mockResolvedValue(null as any);
    await expect(assertEventAccess('missing', { id: 'org-1', role: 'organizer' }))
      .rejects.toMatchObject({ statusCode: 404 } as Partial<ApiError>);
  });

  it('throws 403 when an organizer reads another organizer\'s event', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow({ organizerId: 'org-OTHER' }) as any);
    await expect(assertEventAccess('event-1', { id: 'org-1', role: 'organizer' }))
      .rejects.toMatchObject({ statusCode: 403 } as Partial<ApiError>);
  });

  it('allows an organizer to read their own event', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    await expect(assertEventAccess('event-1', { id: 'org-1', role: 'organizer' }))
      .resolves.toMatchObject({ id: 'event-1' });
  });

  it('allows an admin to read any organizer\'s event', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow({ organizerId: 'org-OTHER' }) as any);
    await expect(assertEventAccess('event-1', { id: 'admin-1', role: 'admin' }))
      .resolves.toMatchObject({ id: 'event-1' });
  });
});

describe('getOrganizerEarnings — derived from real sold tickets', () => {
  it('sums ticketType.price over sold tickets per event', async () => {
    prismaMock.event.findMany.mockResolvedValue([
      { id: 'event-1', title: 'Fest A' },
      { id: 'event-2', title: 'Fest B' },
    ] as any);
    // 2 sold for event-1 @100, 1 sold for event-2 @50 -> totals 200 / 50 / 250.
    prismaMock.ticket.findMany.mockResolvedValue([
      { eventId: 'event-1', ticketType: { price: 100 } },
      { eventId: 'event-1', ticketType: { price: 100 } },
      { eventId: 'event-2', ticketType: { price: 50 } },
    ] as any);

    const result = await getOrganizerEarnings({ id: 'org-1', role: 'organizer' });

    expect(result.totalEarnings).toBe(250);
    expect(result.earningsPerEvent).toEqual([
      { eventId: 'event-1', name: 'Fest A', totalEarnings: 200 },
      { eventId: 'event-2', name: 'Fest B', totalEarnings: 50 },
    ]);
    // Only SOLD tickets feed earnings.
    const ticketWhere = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(ticketWhere.status).toBe('sold');
  });
});

describe('getEventDetailsForOrganizer — stats from real ticket rows', () => {
  it('preserves historical sold and reserved amounts through repricing and agrees with earnings', async () => {
    const event = eventRow({ ticketTypes: [
      { id: 'tt-1', name: 'VIP', price: 100, quantity: 50 },
      { id: 'tt-2', name: 'General', price: 50, quantity: 20 },
      { id: 'tt-3', name: 'Unused', price: 20, quantity: 10 },
    ] });
    const rows = [
      ...[100, 100, 100, 150, 0].map(amountPaid => ({
        eventId: 'event-1', ticketTypeId: 'tt-1', status: 'sold', amountPaid,
      })),
      { eventId: 'event-1', ticketTypeId: 'tt-2', status: 'sold', amountPaid: 40 },
      { eventId: 'event-1', ticketTypeId: 'tt-1', status: 'reserved', amountPaid: 80 },
      { eventId: 'event-1', ticketTypeId: 'tt-1', status: 'reserved', amountPaid: 0 },
      { eventId: 'event-1', ticketTypeId: 'tt-1', status: 'cancelled', amountPaid: 900 },
      { eventId: 'event-1', ticketTypeId: 'tt-1', status: 'refunded', amountPaid: 700 },
    ];
    prismaMock.event.findUnique.mockResolvedValue(event as any);
    prismaMock.event.findMany.mockResolvedValue([event] as any);
    prismaMock.ticket.findMany.mockImplementation(async (args: any) => {
      expect(['sold', 'reserved']).toContain(args.where.status);
      expect(args.include?.ticketType || args.select?.ticketType).toBeTruthy();
      if (args.select) expect(args.select.amountPaid).toBe(true);
      return rows.filter(row => row.status === args.where.status).map(row => ({
        ...row, ticketType: event.ticketTypes.find(tt => tt.id === row.ticketTypeId),
      })) as any;
    });
    prismaMock.ticket.groupBy.mockResolvedValue([
      { ticketTypeId: 'tt-1', _count: { _all: 43 } },
      { ticketTypeId: 'tt-2', _count: { _all: 19 } },
      { ticketTypeId: 'tt-3', _count: { _all: 10 } },
    ] as any);

    const before = await getEventDetailsForOrganizer('event-1', { id: 'org-1', role: 'organizer' });
    event.ticketTypes[0].price = 200;
    event.ticketTypes[1].price = 300;
    const after = await getEventDetailsForOrganizer('event-1', { id: 'org-1', role: 'organizer' });
    expect(after.stats).toEqual(before.stats);
    expect(after.event.title).toBe('Test Fest');
    expect(after.stats).toEqual({
      totalTicketsSold: 6, totalRevenue: 490, pendingPayments: 80,
      ticketTypes: [
        { name: 'VIP', sold: 5, available: 43, revenue: 450 },
        { name: 'General', sold: 1, available: 19, revenue: 40 },
        { name: 'Unused', sold: 0, available: 10, revenue: 0 },
      ],
    });
    expect(after.stats.ticketTypes.reduce((sum, tt) => sum + tt.revenue, 0)).toBe(after.stats.totalRevenue);
    const earnings = await getOrganizerEarnings({ id: 'org-1', role: 'organizer' });
    expect(after.stats.totalRevenue).toBe(earnings.totalEarnings);
    for (const [args] of prismaMock.ticket.groupBy.mock.calls) {
      expect(args?.where).toEqual({ eventId: 'event-1', status: 'available' });
    }
  });

  it('returns zero totals for unsold inventory', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    prismaMock.ticket.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([
      { ticketTypeId: 'tt-1', _count: { _all: 50 } },
    ] as any);
    const { stats } = await getEventDetailsForOrganizer('event-1', { id: 'org-1', role: 'organizer' });
    expect(stats).toEqual({ totalRevenue: 0, totalTicketsSold: 0, pendingPayments: 0,
      ticketTypes: [{ name: 'VIP', sold: 0, available: 50, revenue: 0 }] });
  });
});

describe('getOrganizerDashboardStats — KPIs from real sold tickets', () => {
  it('derives revenue/sold/avg from sold rows and active-event count from event state', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    prismaMock.event.findMany.mockResolvedValue([
      { id: 'event-1', isPublished: true, isCancelled: false, endDate: future }, // active
      { id: 'event-2', isPublished: false, isCancelled: false, endDate: future }, // unpublished
      { id: 'event-3', isPublished: true, isCancelled: true, endDate: future }, // cancelled
      { id: 'event-4', isPublished: true, isCancelled: false, endDate: past }, // ended
    ] as any);
    // amountPaid wins when present; falls back to type price for legacy rows.
    prismaMock.ticket.findMany.mockResolvedValue([
      { amountPaid: 120, ticketType: { price: 100 } },
      { amountPaid: null, ticketType: { price: 80 } },
    ] as any);

    const stats = await getOrganizerDashboardStats({ id: 'org-1', role: 'organizer' });

    expect(stats.totalRevenue).toBe(200);
    expect(stats.ticketsSold).toBe(2);
    expect(stats.activeEvents).toBe(1);
    expect(stats.averageTicketPrice).toBe(100);
    // Only the caller's own SOLD tickets feed the totals.
    const ticketWhere = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(ticketWhere.status).toBe('sold');
    const eventWhere = (prismaMock.event.findMany.mock.calls[0][0] as any).where;
    expect(eventWhere.organizerId).toBe('org-1');
  });

  it('returns zeros (no division by zero) when nothing is sold', async () => {
    prismaMock.event.findMany.mockResolvedValue([] as any);

    const stats = await getOrganizerDashboardStats({ id: 'org-1', role: 'organizer' });

    expect(stats).toEqual({ totalRevenue: 0, ticketsSold: 0, activeEvents: 0, averageTicketPrice: 0 });
    // No events -> never queries tickets.
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('getOrganizerMonthlyStats — zero-filled trailing window', () => {
  it('returns a 6-month series and buckets a current-month sale', async () => {
    prismaMock.event.findMany.mockResolvedValue([{ id: 'event-1' }] as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      { purchaseDate: new Date(), amountPaid: 100, ticketType: { price: 100 } },
    ] as any);

    const series = await getOrganizerMonthlyStats({ id: 'org-1', role: 'organizer' });

    expect(series).toHaveLength(6);
    // Exactly one ticket worth 100 lands in the (current) month bucket.
    const totalTickets = series.reduce((s, m) => s + m.tickets, 0);
    const totalRevenue = series.reduce((s, m) => s + m.revenue, 0);
    expect(totalTickets).toBe(1);
    expect(totalRevenue).toBe(100);
    // Only the caller's own SOLD tickets are queried.
    const where = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe('sold');
    expect(where.purchaseDate.gte).toBeInstanceOf(Date);
  });

  it('returns 6 zero-filled months when the organizer has no events', async () => {
    prismaMock.event.findMany.mockResolvedValue([] as any);

    const series = await getOrganizerMonthlyStats({ id: 'org-1', role: 'organizer' });

    expect(series).toHaveLength(6);
    expect(series.every((m) => m.tickets === 0 && m.revenue === 0)).toBe(true);
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('getOrganizerRecentActivity — real recent-sale feed', () => {
  it('maps recent sold tickets to activity items with ISO timestamps', async () => {
    prismaMock.event.findMany.mockResolvedValue([{ id: 'event-1' }] as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'ticket-1',
        user: { name: 'Buyer One' },
        ticketType: { name: 'VIP', price: 100 },
        event: { title: 'Test Fest' },
        amountPaid: 100,
        purchaseDate: new Date('2026-06-01T10:00:00Z'),
        createdAt: new Date('2026-06-01T09:00:00Z'),
      },
    ] as any);

    const activity = await getOrganizerRecentActivity({ id: 'org-1', role: 'organizer' });

    expect(activity[0]).toEqual({
      id: 'ticket-1',
      title: 'Ticket sold — Test Fest',
      message: 'Buyer One bought a VIP ticket for SZL 100',
      time: '2026-06-01T10:00:00.000Z',
    });
    const where = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toBe('sold');
  });

  it('returns an empty feed when the organizer has no events', async () => {
    prismaMock.event.findMany.mockResolvedValue([] as any);

    const activity = await getOrganizerRecentActivity({ id: 'org-1', role: 'organizer' });

    expect(activity).toEqual([]);
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('getEventPurchases — pagination + ownership', () => {
  it('rejects a non-owner before reading purchases', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow({ organizerId: 'org-OTHER' }) as any);
    await expect(
      getEventPurchases('event-1', { id: 'org-1', role: 'organizer' }, '1', '10')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('maps issued tickets to purchase rows and excludes available inventory', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    prismaMock.ticket.count.mockResolvedValue(1 as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'ticket-1',
        user: { name: 'Buyer One' },
        ticketType: { name: 'VIP', price: 100 },
        amountPaid: 100,
        purchaseDate: new Date('2026-06-01T10:00:00Z'),
        createdAt: new Date('2026-06-01T09:00:00Z'),
        status: 'sold',
      },
    ] as any);

    const result = await getEventPurchases('event-1', { id: 'org-1', role: 'organizer' }, '1', '10');

    expect(result.currentPage).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.purchases[0]).toEqual({
      id: 'ticket-1',
      customerName: 'Buyer One',
      ticketType: 'VIP',
      quantity: 1,
      totalAmount: 100,
      purchaseDate: new Date('2026-06-01T10:00:00Z'),
      status: 'sold',
      refundRequestedAt: null,
      refundRequestReason: null,
    });
    // Only non-available (issued) tickets are queried.
    const where = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toEqual({ not: 'available' });
  });

  it('surfaces a pending buyer refund request so the organizer can see it', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    prismaMock.ticket.count.mockResolvedValue(1 as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'ticket-1',
        user: { name: 'Buyer One' },
        ticketType: { name: 'VIP', price: 100 },
        amountPaid: 100,
        purchaseDate: new Date('2026-06-01T10:00:00Z'),
        createdAt: new Date('2026-06-01T09:00:00Z'),
        status: 'sold',
        refundRequestedAt: new Date('2026-06-02T10:00:00Z'),
        refundRequestReason: 'plans changed',
      },
    ] as any);

    const result = await getEventPurchases('event-1', { id: 'org-1', role: 'organizer' }, '1', '10');

    expect(result.purchases[0]).toMatchObject({
      refundRequestedAt: new Date('2026-06-02T10:00:00Z'),
      refundRequestReason: 'plans changed',
    });
  });
});

describe('getEventTickets — pagination + ownership', () => {
  it('rejects a non-owner before reading tickets', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow({ organizerId: 'org-OTHER' }) as any);
    await expect(
      getEventTickets('event-1', { id: 'org-1', role: 'organizer' }, '1', '10')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('surfaces a pending buyer refund request alongside the ticket row', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    prismaMock.ticket.count.mockResolvedValue(1 as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'ticket-1',
        user: { name: 'Buyer One' },
        ticketType: { name: 'VIP', price: 100 },
        purchaseDate: new Date('2026-06-01T10:00:00Z'),
        createdAt: new Date('2026-06-01T09:00:00Z'),
        status: 'sold',
        refundRequestedAt: new Date('2026-06-02T10:00:00Z'),
        refundRequestReason: 'plans changed',
      },
    ] as any);

    const result = await getEventTickets('event-1', { id: 'org-1', role: 'organizer' }, '1', '10');

    expect(result.tickets[0]).toMatchObject({
      id: 'ticket-1',
      ownerName: 'Buyer One',
      refundRequestedAt: new Date('2026-06-02T10:00:00Z'),
      refundRequestReason: 'plans changed',
    });
  });

  it('reports no pending refund request for a ticket without one', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    prismaMock.ticket.count.mockResolvedValue(1 as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      {
        id: 'ticket-2',
        user: { name: 'Buyer Two' },
        ticketType: { name: 'General', price: 50 },
        purchaseDate: new Date('2026-06-01T10:00:00Z'),
        createdAt: new Date('2026-06-01T09:00:00Z'),
        status: 'sold',
        refundRequestedAt: null,
        refundRequestReason: null,
      },
    ] as any);

    const result = await getEventTickets('event-1', { id: 'org-1', role: 'organizer' }, '1', '10');

    expect(result.tickets[0]).toMatchObject({
      refundRequestedAt: null,
      refundRequestReason: null,
    });
  });
});
