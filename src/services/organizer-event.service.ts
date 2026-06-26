import prisma from '../config/prisma';
import { ApiError } from '../middleware/error.middleware';
import { UserRole } from '../interfaces/user.interface';
import { TICKET_CURRENCY as CURRENCY } from '../config/currency';

/**
 * Organizer-dashboard read models.
 *
 * These power the customer-dashboard (the ORGANIZER dashboard) pages — EventList,
 * Earnings and EventDetails. Their response shapes are dictated by what those
 * pages and customer-dashboard/src/lib/event-api.ts consume, which is the legacy
 * `_id`/`date`/string-`location` shape rather than the buyer-app event shape from
 * event.service.ts — hence a dedicated transform here instead of reusing
 * `transformEvent`.
 *
 * Two invariants run through every function:
 *  1. Money is ALWAYS derived from real sold ticket rows joined to
 *     `ticketType.price` — never a stored/mocked total.
 *  2. Ownership is enforced: an organizer may only read their OWN events and
 *     stats; an admin may read any. {@link assertEventAccess} is the single
 *     choke point for that rule.
 */

interface Requester {
  id: string;
  role: string;
}

/** A "purchase"/"ticket" row is any ticket that is not raw unsold inventory. */
const ISSUED_TICKET_FILTER = { status: { not: 'available' as const } };

/**
 * Shape a Prisma event into the legacy object the organizer dashboard expects.
 * `ticketsSold` is passed in (computed from real sold rows) so this stays a pure
 * transform.
 */
const toDashboardEvent = (event: any, ticketsSold: number) => ({
  _id: event.id,
  id: event.id,
  name: event.title,
  title: event.title,
  description: event.description,
  date: event.startDate,
  startDate: event.startDate,
  endDate: event.endDate,
  location: [event.locationAddress, event.locationCity, event.locationCountry]
    .filter(Boolean)
    .join(', '),
  organizer: event.organizerId,
  currency: CURRENCY,
  country: event.locationCountry,
  isPublished: event.isPublished,
  isCancelled: event.isCancelled ?? false,
  coverImage: event.coverImage,
  category: event.category,
  ticketsSold,
  ticketTypes: (event.ticketTypes || []).map((tt: any) => ({
    _id: tt.id,
    id: tt.id,
    name: tt.name,
    price: tt.price,
    quantity: tt.quantity,
  })),
});

/**
 * Load an event and enforce that `requester` is allowed to read it: organizers
 * only their own, admins any. Throws 404 if the event does not exist and 403 if
 * it belongs to another organizer — so ownership can never be bypassed by
 * guessing an id.
 */
export const assertEventAccess = async (eventId: string, requester: Requester) => {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: { ticketTypes: true },
  });

  if (!event) {
    throw new ApiError('Event not found', 404);
  }

  if (requester.role !== UserRole.ADMIN && event.organizerId !== requester.id) {
    throw new ApiError('You do not have permission to access this event', 403);
  }

  return event;
};

/**
 * Count sold tickets per event for the given event ids in one query.
 * Returns a Map<eventId, soldCount>; events with no sales are absent (treated as 0).
 */
const soldCountByEvent = async (eventIds: string[]): Promise<Map<string, number>> => {
  if (eventIds.length === 0) return new Map();
  const grouped = await prisma.ticket.groupBy({
    by: ['eventId'],
    where: { eventId: { in: eventIds }, status: 'sold' },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.eventId, g._count._all]));
};

/**
 * The logged-in organizer's own events (GET /api/user/events), newest start
 * first, optionally bounded by a start-date window. Returns the bare array the
 * dashboard's EventList renders.
 */
export const getOrganizerEvents = async (
  requester: Requester,
  startDate?: string,
  endDate?: string
) => {
  const where: any = { organizerId: requester.id };
  if (startDate || endDate) {
    where.startDate = {};
    if (startDate) where.startDate.gte = new Date(startDate);
    if (endDate) where.startDate.lte = new Date(endDate);
  }

  const events = await prisma.event.findMany({
    where,
    include: { ticketTypes: true },
    orderBy: { startDate: 'desc' },
  });

  const soldMap = await soldCountByEvent(events.map((e) => e.id));
  return events.map((event) => toDashboardEvent(event, soldMap.get(event.id) || 0));
};

/**
 * Total + per-event earnings for the logged-in organizer (GET /api/events/earnings).
 * Earnings are the sum of `ticketType.price` over the organizer's SOLD tickets,
 * grouped by event.
 */
export const getOrganizerEarnings = async (requester: Requester) => {
  const events = await prisma.event.findMany({
    where: { organizerId: requester.id },
    select: { id: true, title: true },
    orderBy: { startDate: 'desc' },
  });

  const eventIds = events.map((e) => e.id);
  const earningsByEvent = new Map<string, number>();

  if (eventIds.length > 0) {
    const soldTickets = await prisma.ticket.findMany({
      where: { eventId: { in: eventIds }, status: 'sold' },
      select: { eventId: true, ticketType: { select: { price: true } } },
    });
    for (const t of soldTickets) {
      const price = t.ticketType?.price || 0;
      earningsByEvent.set(t.eventId, (earningsByEvent.get(t.eventId) || 0) + price);
    }
  }

  const earningsPerEvent = events.map((event) => ({
    eventId: event.id,
    name: event.title,
    totalEarnings: earningsByEvent.get(event.id) || 0,
  }));

  const totalEarnings = earningsPerEvent.reduce((sum, e) => sum + e.totalEarnings, 0);

  return { totalEarnings, earningsPerEvent };
};

/**
 * Full stats for a single event the organizer owns (GET /api/events/:id/details).
 * All counts/revenue are computed from real ticket rows:
 *  - sold/available counts per ticket type (from the inventory rows),
 *  - revenue per type = sold count × that type's price,
 *  - pendingPayments = value of tickets still RESERVED (held, awaiting an async
 *    mobile-money confirmation) — i.e. outstanding unpaid money.
 */
export const getEventDetailsForOrganizer = async (eventId: string, requester: Requester) => {
  const event = await assertEventAccess(eventId, requester);

  const [soldByType, availableByType, reservedTickets] = await Promise.all([
    prisma.ticket.groupBy({
      by: ['ticketTypeId'],
      where: { eventId, status: 'sold' },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ['ticketTypeId'],
      where: { eventId, status: 'available' },
      _count: { _all: true },
    }),
    prisma.ticket.findMany({
      where: { eventId, status: 'reserved' },
      select: { ticketType: { select: { price: true } } },
    }),
  ]);

  const soldMap = new Map(soldByType.map((g) => [g.ticketTypeId, g._count._all]));
  const availableMap = new Map(availableByType.map((g) => [g.ticketTypeId, g._count._all]));

  const ticketTypes = event.ticketTypes.map((tt) => {
    const sold = soldMap.get(tt.id) || 0;
    const available = availableMap.get(tt.id) || 0;
    return {
      name: tt.name,
      sold,
      available,
      revenue: sold * tt.price,
    };
  });

  const totalTicketsSold = ticketTypes.reduce((sum, t) => sum + t.sold, 0);
  const totalRevenue = ticketTypes.reduce((sum, t) => sum + t.revenue, 0);
  const pendingPayments = reservedTickets.reduce((sum, t) => sum + (t.ticketType?.price || 0), 0);

  return {
    event: toDashboardEvent(event, totalTicketsSold),
    stats: {
      totalRevenue,
      totalTicketsSold,
      pendingPayments,
      ticketTypes,
    },
  };
};

/** Money a single sold ticket actually brought in: what YeboPay charged
 *  (`amountPaid`) when present, else the ticket type's list price. Mirrors the
 *  per-purchase amount in {@link getEventPurchases} so every revenue figure on
 *  the dashboard is derived the same way. */
const ticketRevenue = (t: { amountPaid?: number | null; ticketType?: { price: number } | null }) =>
  t.amountPaid ?? t.ticketType?.price ?? 0;

/**
 * Headline KPIs for the organizer dashboard landing page
 * (GET /api/user/dashboard-stats). All figures are scoped to the caller's own
 * events and computed from real ticket rows — never stored/mocked totals:
 *  - totalRevenue: sum of what was actually charged over the organizer's SOLD
 *    tickets (amountPaid, falling back to the type price for legacy rows),
 *  - ticketsSold: count of those sold tickets,
 *  - averageTicketPrice: totalRevenue / ticketsSold (0 when nothing is sold),
 *  - activeEvents: published, non-cancelled events that have not yet ended.
 *
 * Returns the BARE object the dashboard's KpiCards read directly.
 */
export const getOrganizerDashboardStats = async (requester: Requester) => {
  const events = await prisma.event.findMany({
    where: { organizerId: requester.id },
    select: { id: true, isPublished: true, isCancelled: true, endDate: true },
  });

  const now = new Date();
  const activeEvents = events.filter(
    (e) => e.isPublished && !e.isCancelled && e.endDate >= now
  ).length;

  const eventIds = events.map((e) => e.id);
  let totalRevenue = 0;
  let ticketsSold = 0;

  if (eventIds.length > 0) {
    const soldTickets = await prisma.ticket.findMany({
      where: { eventId: { in: eventIds }, status: 'sold' },
      select: { amountPaid: true, ticketType: { select: { price: true } } },
    });
    ticketsSold = soldTickets.length;
    totalRevenue = soldTickets.reduce((sum, t) => sum + ticketRevenue(t), 0);
  }

  const averageTicketPrice = ticketsSold > 0 ? totalRevenue / ticketsSold : 0;

  return { totalRevenue, ticketsSold, activeEvents, averageTicketPrice };
};

/** How many trailing calendar months the sales chart spans. */
const MONTHLY_STATS_WINDOW = 6;

/** Short "MMM YYYY" bucket label (e.g. "Jan 2026") for a given year/month. */
const monthLabel = (year: number, monthIndex: number) =>
  new Date(Date.UTC(year, monthIndex, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/**
 * Per-month sold-ticket count and revenue for the organizer's events over the
 * trailing {@link MONTHLY_STATS_WINDOW} months (GET /api/user/monthly-stats),
 * oldest month first. Every month in the window is present (zero-filled) so the
 * chart renders a continuous line rather than collapsing gaps. Scoped to the
 * caller's own events; revenue derived from real sold rows.
 */
export const getOrganizerMonthlyStats = async (requester: Requester) => {
  // Pre-seed the trailing window so months with no sales still appear as zeros.
  const now = new Date();
  const buckets: { key: string; date: string; tickets: number; revenue: number }[] = [];
  const indexByKey = new Map<string, number>();
  for (let i = MONTHLY_STATS_WINDOW - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    indexByKey.set(key, buckets.length);
    buckets.push({ key, date: monthLabel(d.getUTCFullYear(), d.getUTCMonth()), tickets: 0, revenue: 0 });
  }

  const events = await prisma.event.findMany({
    where: { organizerId: requester.id },
    select: { id: true },
  });
  const eventIds = events.map((e) => e.id);

  if (eventIds.length > 0) {
    // Lower bound = first day of the oldest month in the window.
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHLY_STATS_WINDOW - 1), 1)
    );
    const soldTickets = await prisma.ticket.findMany({
      where: {
        eventId: { in: eventIds },
        status: 'sold',
        purchaseDate: { gte: windowStart },
      },
      select: { purchaseDate: true, amountPaid: true, ticketType: { select: { price: true } } },
    });

    for (const t of soldTickets) {
      if (!t.purchaseDate) continue;
      const key = `${t.purchaseDate.getUTCFullYear()}-${t.purchaseDate.getUTCMonth()}`;
      const idx = indexByKey.get(key);
      if (idx === undefined) continue;
      buckets[idx].tickets += 1;
      buckets[idx].revenue += ticketRevenue(t);
    }
  }

  return buckets.map(({ date, tickets, revenue }) => ({ date, tickets, revenue }));
};

/** How many recent sales the activity feed returns. */
const RECENT_ACTIVITY_LIMIT = 10;

/**
 * Most recent ticket sales across the organizer's events
 * (GET /api/user/recent-activity), newest first, as a real activity feed —
 * NOT the hardcoded notification array the dashboard used to fake. Each item's
 * `time` is an ISO timestamp the client formats into a relative label. Scoped
 * to the caller's own events.
 */
export const getOrganizerRecentActivity = async (requester: Requester) => {
  const events = await prisma.event.findMany({
    where: { organizerId: requester.id },
    select: { id: true },
  });
  const eventIds = events.map((e) => e.id);
  if (eventIds.length === 0) return [];

  const tickets = await prisma.ticket.findMany({
    where: { eventId: { in: eventIds }, status: 'sold' },
    include: {
      user: { select: { name: true } },
      ticketType: { select: { name: true, price: true } },
      event: { select: { title: true } },
    },
    orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
    take: RECENT_ACTIVITY_LIMIT,
  });

  return tickets.map((t) => {
    const customerName = t.user?.name || 'A customer';
    const typeName = t.ticketType?.name || 'ticket';
    const eventTitle = t.event?.title || 'your event';
    const amount = ticketRevenue(t);
    return {
      id: t.id,
      title: `Ticket sold — ${eventTitle}`,
      message: `${customerName} bought a ${typeName} ticket for ${CURRENCY} ${amount.toLocaleString()}`,
      time: (t.purchaseDate ?? t.createdAt).toISOString(),
    };
  });
};

/** Parse + clamp pagination query params to sane bounds. */
const parsePagination = (page?: any, limit?: any) => {
  const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 10));
  return { page: parsedPage, limit: parsedLimit, skip: (parsedPage - 1) * parsedLimit };
};

/**
 * Paginated purchase history for an event the organizer owns
 * (GET /api/events/:id/purchases). Each issued ticket row is one purchase line
 * (the buyer flow sells one ticket per charge, so quantity is 1) carrying the
 * buyer name, type, amount actually paid and current status.
 */
export const getEventPurchases = async (
  eventId: string,
  requester: Requester,
  pageParam?: any,
  limitParam?: any
) => {
  await assertEventAccess(eventId, requester);
  const { page, limit, skip } = parsePagination(pageParam, limitParam);

  const where = { eventId, ...ISSUED_TICKET_FILTER };

  const [total, tickets] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.findMany({
      where,
      include: {
        user: { select: { name: true } },
        ticketType: { select: { name: true, price: true } },
      },
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
  ]);

  const purchases = tickets.map((t) => ({
    id: t.id,
    customerName: t.user?.name || 'Unknown',
    ticketType: t.ticketType?.name || 'Unknown',
    quantity: 1,
    totalAmount: t.amountPaid ?? t.ticketType?.price ?? 0,
    purchaseDate: t.purchaseDate ?? t.createdAt,
    status: t.status,
  }));

  return {
    purchases,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
};

/**
 * Paginated issued-ticket list for an event the organizer owns
 * (GET /api/events/:id/tickets). One row per issued ticket with its type, price,
 * holder and validity (the event end date).
 */
export const getEventTickets = async (
  eventId: string,
  requester: Requester,
  pageParam?: any,
  limitParam?: any
) => {
  const event = await assertEventAccess(eventId, requester);
  const { page, limit, skip } = parsePagination(pageParam, limitParam);

  const where = { eventId, ...ISSUED_TICKET_FILTER };

  const [total, tickets] = await Promise.all([
    prisma.ticket.count({ where }),
    prisma.ticket.findMany({
      where,
      include: {
        user: { select: { name: true } },
        ticketType: { select: { name: true, price: true } },
      },
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
  ]);

  const ticketRows = tickets.map((t) => ({
    id: t.id,
    ticketType: t.ticketType?.name || 'Unknown',
    price: t.ticketType?.price ?? 0,
    purchaseDate: t.purchaseDate ?? t.createdAt,
    validUntil: event.endDate,
    status: t.status,
    ownerName: t.user?.name || 'Unknown',
  }));

  return {
    tickets: ticketRows,
    currentPage: page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
};
