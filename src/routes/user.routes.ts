import express from 'express';
import {
  getUserEventsController,
  getDashboardStatsController,
  getMonthlyStatsController,
  getRecentActivityController,
} from '../controllers/organizer-event.controller';
import { protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';

const router = express.Router();

/**
 * @swagger
 * /api/user/events:
 *   get:
 *     summary: Get the logged-in organizer's own events
 *     tags: [User]
 *     description: >
 *       Canonical path for the organizer dashboard's event list. Returns the
 *       caller's own events only (organizers and admins alike see their own).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Array of the organizer's events
 */
router.get('/events', protect, authorize(UserRole.ORGANIZER, UserRole.ADMIN), getUserEventsController);

/**
 * @swagger
 * /api/user/dashboard-stats:
 *   get:
 *     summary: Headline KPIs for the organizer dashboard landing page
 *     tags: [User]
 *     description: >
 *       Totals scoped to the caller's own events, computed from real sold ticket
 *       rows: total revenue (SZL), tickets sold, active (published, non-cancelled,
 *       not-yet-ended) event count, and average ticket price.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "Bare object: { totalRevenue, ticketsSold, activeEvents, averageTicketPrice }"
 */
router.get('/dashboard-stats', protect, authorize(UserRole.ORGANIZER, UserRole.ADMIN), getDashboardStatsController);

/**
 * @swagger
 * /api/user/monthly-stats:
 *   get:
 *     summary: Per-month sold/revenue series for the organizer sales chart
 *     tags: [User]
 *     description: >
 *       Array of the trailing 6 calendar months (oldest first, zero-filled) for
 *       the caller's own events, each with a "MMM YYYY" label, tickets sold and
 *       revenue (SZL).
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "Bare array of { date, tickets, revenue }"
 */
router.get('/monthly-stats', protect, authorize(UserRole.ORGANIZER, UserRole.ADMIN), getMonthlyStatsController);

/**
 * @swagger
 * /api/user/recent-activity:
 *   get:
 *     summary: Real recent ticket-sale feed for the organizer
 *     tags: [User]
 *     description: >
 *       Up to 10 most recent ticket sales across the caller's own events, newest
 *       first. Each item carries an ISO `time` the client renders as a relative
 *       label.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "Bare array of { id, title, message, time }"
 */
router.get('/recent-activity', protect, authorize(UserRole.ORGANIZER, UserRole.ADMIN), getRecentActivityController);

export default router;
