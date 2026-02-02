import { Router, Request, Response } from 'express';
import prisma from '../config/prisma';
import { verifyDashboardApiKey } from '../middleware/auth.middleware';

const router = Router();

/**
 * @swagger
 * /api/dashboard/metrics:
 *   get:
 *     summary: Get dashboard metrics for CEO dashboard
 *     tags: [Dashboard]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics
 */
router.get('/metrics', verifyDashboardApiKey, async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // Get active events (published and end date is in the future)
    const activeEvents = await prisma.event.count({
      where: {
        isPublished: true,
        endDate: { gte: now },
      },
    });

    // Get active events from previous period for comparison
    const previousActiveEvents = await prisma.event.count({
      where: {
        isPublished: true,
        endDate: { gte: thirtyDaysAgo, lt: now },
      },
    });

    // Get tickets sold in the last 30 days
    const ticketsSoldCurrent = await prisma.ticket.count({
      where: {
        status: 'sold',
        purchaseDate: { gte: thirtyDaysAgo },
      },
    });

    // Get tickets sold in the previous 30 days
    const ticketsSoldPrevious = await prisma.ticket.count({
      where: {
        status: 'sold',
        purchaseDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
    });

    // Calculate revenue (sum of ticket prices for sold tickets)
    const revenueCurrentResult = await prisma.ticket.findMany({
      where: {
        status: 'sold',
        purchaseDate: { gte: thirtyDaysAgo },
      },
      include: {
        ticketType: {
          select: { price: true },
        },
      },
    });
    const revenueCurrent = revenueCurrentResult.reduce((sum, t) => sum + (t.ticketType?.price || 0), 0);

    const revenuePreviousResult = await prisma.ticket.findMany({
      where: {
        status: 'sold',
        purchaseDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
      include: {
        ticketType: {
          select: { price: true },
        },
      },
    });
    const revenuePrevious = revenuePreviousResult.reduce((sum, t) => sum + (t.ticketType?.price || 0), 0);

    // Get organizers count
    const organizersCurrent = await prisma.user.count({
      where: {
        role: 'organizer',
        createdAt: { lte: now },
      },
    });

    const organizersPrevious = await prisma.user.count({
      where: {
        role: 'organizer',
        createdAt: { lte: thirtyDaysAgo },
      },
    });

    // Calculate trends and percentages
    const calculateTrend = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 'up' : 'neutral';
      return current > previous ? 'up' : current < previous ? 'down' : 'neutral';
    };

    const calculateChangePercent = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    res.json({
      success: true,
      data: {
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
          currency: 'KES',
        },
        organizers: {
          value: organizersCurrent,
          trend: calculateTrend(organizersCurrent, organizersPrevious),
          changePercent: calculateChangePercent(organizersCurrent, organizersPrevious),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching dashboard metrics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch metrics' });
  }
});

export default router;
