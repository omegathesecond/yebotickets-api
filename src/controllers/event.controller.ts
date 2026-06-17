import { Request, Response, NextFunction } from 'express';
import { 
  createEvent, 
  getEvents, 
  getEventById, 
  updateEvent, 
  deleteEvent 
} from '../services/event.service';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';

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

export const getEventsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const isAdmin = authReq.user?.role === 'admin';

    // The showUnpublished flag exposes draft/unpublished events, so it must never
    // be honoured from untrusted query input. It is only safe when the caller is
    // entitled to see those events:
    //   - admins may list every unpublished event; or
    //   - an authenticated caller whose request is scoped to their OWN events
    //     (query.organizer === their user id) — this is how /organizers/events
    //     and the scanner-app legitimately read their own drafts.
    // Anonymous/public callers have no req.user, so they can never satisfy this
    // and the public list stays published-only.
    const ownerId = authReq.user?.id;
    const isOwnScopedRequest = !!ownerId && req.query.organizer === ownerId;
    const query = { ...req.query };
    if (!isAdmin && !isOwnScopedRequest) {
      delete query.showUnpublished;
    }

    const events = await getEvents(query);

    res.status(200).json({
      success: true,
      count: events.length,
      data: events,
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
