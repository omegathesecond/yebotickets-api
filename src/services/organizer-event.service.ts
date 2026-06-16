import prisma from '../config/prisma';
import { ApiError } from '../middleware/error.middleware';
import { UserRole } from '../interfaces/user.interface';

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

/** Currency tickets are priced/charged in (Eswatini lilangeni), matching the
 *  buyer flow in ticket.service.ts and the SZL labels the dashboard renders. */
const CURRENCY = 'SZL';

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
