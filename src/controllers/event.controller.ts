import { Request, Response, NextFunction } from 'express';
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  adminUnpublishEvent,
} from '../services/event.service';
import { cancelEvent } from '../services/ticket.service';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';
import { UserRole } from '../interfaces/user.interface';

export const createEventController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const organizerId = authReq.user.id;
    const eventData = req.body;
    
    const event = await createEvent(eventData, organizerId);
    
    res.status(201).json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * This controller is shared by two routes:
 *  - GET /api/events — fully public, no `protect`/`authorize` middleware.
 *  - GET /api/organizers/events — behind protect+authorize(ORGANIZER, ADMIN);
 *    its wrapper middleware sets showUnpublished/organizer server-side so
 *    organizers/staff (including the scanner app) can see their own drafts.
 * Only honour showUnpublished/showCancelled when the caller is an
 * authenticated organizer/admin. Checking role (not merely req.user
 * presence) means this stays safe even if this controller is ever mounted
 * behind `protect` alone without `authorize(ORGANIZER, ADMIN)` — a plain
 * logged-in customer must not be able to enumerate draft/unpublished events
 * (e.g. combined with `organizer` to list a specific organizer's
 * unpublished events) via GET /api/events?showUnpublished=true.
 */
export const getEventsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const privileged =
      authReq.user?.role === UserRole.ORGANIZER || authReq.user?.role === UserRole.ADMIN;
    const query = privileged
      ? req.query
      : (() => {
          const { showUnpublished, showCancelled, ...publicQuery } = req.query;
          return publicQuery;
        })();
    const { data, total, page, limit, hasMore } = await getEvents(query);

    res.status(200).json({
      success: true,
      count: data.length,
      data,
      total,
      page,
      limit,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
};

export const getEventByIdController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const event = await getEventById(id);
    
    res.status(200).json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
};

export const updateEventController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { id } = req.params;
    const organizerId = authReq.user.id;
    const updateData = req.body;
    
    const event = await updateEvent(id, updateData, organizerId);
    
    res.status(200).json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin-only moderation action on ANY event, regardless of organizerId:
 *  - 'unpublish': takes the event off sale/listing immediately (isPublished=false)
 *  - 'cancel': runs the existing cancel path (refunds sold tickets + isCancelled=true)
 * Route is gated by authorize(ADMIN); organizer-owner update/delete are untouched.
 * PATCH /api/events/:id/moderation
 */
export const moderateEventController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { id } = req.params;
    const { action } = req.body;

    if (action === 'unpublish') {
      const event = await adminUnpublishEvent(id);
      return res.status(200).json({ success: true, data: event });
    }

    if (action === 'cancel') {
      const result = await cancelEvent(id, {
        id: authReq.user.id,
        role: authReq.user.role,
      });
      return res.status(200).json({ success: true, data: result });
    }

    return next(new ApiError("Invalid action: must be 'unpublish' or 'cancel'", 400));
  } catch (error) {
    next(error);
  }
};

export const deleteEventController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { id } = req.params;
    const organizerId = authReq.user.id;
    
    const result = await deleteEvent(id, organizerId);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
