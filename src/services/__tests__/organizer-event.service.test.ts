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
  it('computes revenue = sold count x price and pending = reserved value', async () => {
    prismaMock.event.findUnique.mockResolvedValue(eventRow() as any);
    // 3 sold of tt-1 @100, 47 available, 0 reserved value here.
    prismaMock.ticket.groupBy
      .mockResolvedValueOnce([{ ticketTypeId: 'tt-1', _count: { _all: 3 } }] as any) // sold
      .mockResolvedValueOnce([{ ticketTypeId: 'tt-1', _count: { _all: 47 } }] as any); // available
    prismaMock.ticket.findMany.mockResolvedValue([
      { ticketType: { price: 100 } }, // one reserved ticket -> pending 100
    ] as any);

    const { event, stats } = await getEventDetailsForOrganizer('event-1', { id: 'org-1', role: 'organizer' });

    expect(event.title).toBe('Test Fest');
    expect(stats.totalTicketsSold).toBe(3);
    expect(stats.totalRevenue).toBe(300);
    expect(stats.pendingPayments).toBe(100);
    expect(stats.ticketTypes).toEqual([
      { name: 'VIP', sold: 3, available: 47, revenue: 300 },
    ]);
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
    });
    // Only non-available (issued) tickets are queried.
    const where = (prismaMock.ticket.findMany.mock.calls[0][0] as any).where;
    expect(where.status).toEqual({ not: 'available' });
  });
});
