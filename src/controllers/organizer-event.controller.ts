import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';
import {
  getOrganizerEvents,
  getOrganizerEarnings,
  getEventDetailsForOrganizer,
  getEventPurchases,
  getEventTickets,
  getOrganizerDashboardStats,
  getOrganizerMonthlyStats,
  getOrganizerRecentActivity,
} from '../services/organizer-event.service';

/**
 * Controllers for the organizer-dashboard read endpoints.
 *
 * IMPORTANT: unlike the rest of the API (which wraps payloads in
 * `{ success, data }`), these respond with the BARE body. The consuming
 * customer-dashboard client (BaseApi.get) returns `response.data` straight to
 * the page with no unwrapping, so the documented shape must BE the body or the
 * pages render nothing. Ownership is enforced inside the service layer.
 */

const requesterOf = (req: Request): { id: string; role: string } => {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || !authReq.user.id) {
    throw new ApiError('User not authenticated', 401);
  }
  return { id: authReq.user.id, role: authReq.user.role };
};

/** GET /api/user/events — the logged-in organizer's own events. */
export const getUserEventsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const { startDate, endDate } = req.query;
    const events = await getOrganizerEvents(
      requester,
      startDate as string | undefined,
      endDate as string | undefined
    );
    res.status(200).json(events);
  } catch (error) {
    next(error);
  }
};

/** GET /api/user/dashboard-stats — headline KPIs for the organizer landing page. */
export const getDashboardStatsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const stats = await getOrganizerDashboardStats(requester);
    res.status(200).json(stats);
  } catch (error) {
    next(error);
  }
};

/** GET /api/user/monthly-stats — per-month sold/revenue series for the chart. */
export const getMonthlyStatsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const series = await getOrganizerMonthlyStats(requester);
    res.status(200).json(series);
  } catch (error) {
    next(error);
  }
};

/** GET /api/user/recent-activity — real recent ticket-sale feed. */
export const getRecentActivityController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const activity = await getOrganizerRecentActivity(requester);
    res.status(200).json(activity);
  } catch (error) {
    next(error);
  }
};

/** GET /api/events/earnings — total + per-event earnings for the organizer. */
export const getEarningsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const earnings = await getOrganizerEarnings(requester);
    res.status(200).json(earnings);
  } catch (error) {
    next(error);
  }
};

/** GET /api/events/:id/details — event + computed stats (organizer-owned). */
export const getEventDetailsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const details = await getEventDetailsForOrganizer(req.params.id, requester);
    res.status(200).json(details);
  } catch (error) {
    next(error);
  }
};

/** GET /api/events/:id/purchases — paginated purchase history (organizer-owned). */
export const getEventPurchasesController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const result = await getEventPurchases(req.params.id, requester, req.query.page, req.query.limit);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/** GET /api/events/:id/tickets — paginated issued-ticket list (organizer-owned). */
export const getEventTicketsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requester = requesterOf(req);
    const result = await getEventTickets(req.params.id, requester, req.query.page, req.query.limit);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
