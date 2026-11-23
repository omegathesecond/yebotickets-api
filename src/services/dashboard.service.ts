import prisma from '../config/prisma';
import { CURRENCY } from '../config/platform';
import { sumTicketRevenue } from './settlement.service';

/**
 * Platform-wide metrics shared by the CEO dashboard (X-API-Key route) and the
 * YeboTickets platform admin dashboard (JWT + ADMIN route). Kept in one place so
 * both consumers report identical numbers (DRY) and the computation lives outside
 * any auth concern.
 */
export const getDashboardMetrics = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Active events (published, not yet ended)
  const activeEvents = await prisma.event.count({
    where: { isPublished: true, isCancelled: false, endDate: { gte: now } },
  });
  const previousActiveEvents = await prisma.event.count({
    where: { isPublished: true, endDate: { gte: thirtyDaysAgo, lt: now } },
  });

  // Tickets sold (current vs previous 30-day window)
  const ticketsSoldCurrent = await prisma.ticket.count({
    where: { status: 'sold', purchaseDate: { gte: thirtyDaysAgo } },
  });
  const ticketsSoldPrevious = await prisma.ticket.count({
    where: { status: 'sold', purchaseDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
  });

  // Recorded allocations, independent of later edits to a ticket tier's price.
  const revenueCurrentResult = await prisma.ticket.findMany({
    where: { status: 'sold', purchaseDate: { gte: thirtyDaysAgo } },
    select: { amountPaid: true },
  });
  const revenueCurrent = sumTicketRevenue(revenueCurrentResult);

  const revenuePreviousResult = await prisma.ticket.findMany({
    where: { status: 'sold', purchaseDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
    select: { amountPaid: true },
  });
  const revenuePrevious = sumTicketRevenue(revenuePreviousResult);

  // Organizers (cumulative counts as of now vs 30 days ago)
  const organizersCurrent = await prisma.user.count({
    where: { role: 'organizer', createdAt: { lte: now } },
  });
  const organizersPrevious = await prisma.user.count({
    where: { role: 'organizer', createdAt: { lte: thirtyDaysAgo } },
  });

  const calculateTrend = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 'up' : 'neutral';
    return current > previous ? 'up' : current < previous ? 'down' : 'neutral';
  };

  const calculateChangePercent = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  return {
    activeEvents: {
      value: activeEvents,
      trend: calculateTrend(activeEvents, previousActiveEvents),
      changePercent: calculateChangePercent(activeEvents, previousActiveEvents),
    },
    ticketsSold: {
      value: ticketsSoldCurrent,
      trend: calculateTrend(ticketsSoldCurrent, ticketsSoldPrevious),
      changePercent: calculateChangePercent(ticketsSoldCurrent, ticketsSoldPrevious),
    },
    revenue: {
      value: revenueCurrent,
      trend: calculateTrend(revenueCurrent, revenuePrevious),
      changePercent: calculateChangePercent(revenueCurrent, revenuePrevious),
      currency: CURRENCY,
    },
    organizers: {
      value: organizersCurrent,
      trend: calculateTrend(organizersCurrent, organizersPrevious),
      changePercent: calculateChangePercent(organizersCurrent, organizersPrevious),
    },
  };
};
