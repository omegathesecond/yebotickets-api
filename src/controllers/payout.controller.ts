import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { ApiError } from '../middleware/error.middleware';
import * as payoutService from '../services/payout.service';

/** GET /api/organizers/payout-method — the caller's own payout details. */
export const getPayoutMethodController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await payoutService.getPayoutMethod(authReq.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/organizers/payout-method — update the caller's own payout details. */
export const updatePayoutMethodController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await payoutService.updatePayoutMethod(authReq.user.id, req.body);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/organizers/payout-balance — the caller's settlement statement:
 * gross sales, refunds, money held back for unfinished events, the platform
 * fee, what has been paid out or reserved, and the resulting available balance,
 * with a per-event breakdown.
 */
export const getPayoutBalanceController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await payoutService.getOrganizerBalance(authReq.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** POST /api/organizers/payout-requests — the caller requests a withdrawal. */
export const createPayoutRequestController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const amount = Number(req.body.amount);
    const data = await payoutService.createPayoutRequest(authReq.user.id, amount);
    res.status(201).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/organizers/payout-requests — the caller's own payout request history. */
export const getPayoutRequestsController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const data = await payoutService.getOrganizerPayoutRequests(authReq.user.id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/organizers/admin/payout-requests — admin: all requests, optionally ?status=. */
export const listPayoutRequestsController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const status = req.query.status as string | undefined;
    const data = await payoutService.listPayoutRequests(status);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/organizers/admin/payout-requests/:id — admin advances a request:
 * approved (cleared to pay), paid (transfer done — `reference` required) or
 * rejected (amount released back to the organizer's balance).
 */
export const updatePayoutRequestController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, adminNote, reference } = req.body;
    if (!id) {
      next(new ApiError('Payout request id is required', 400));
      return;
    }
    const data = await payoutService.updatePayoutRequestStatus(id, status, { adminNote, reference });
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
