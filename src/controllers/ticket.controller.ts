import { Request, Response, NextFunction } from 'express';
import { 
  createTicketType,
  getTicketTypes,
  updateTicketType,
  deleteTicketType,
  generateTickets,
  purchaseTicket,
  getUserTickets,
  verifyTicket,
  getCheckInDetails,
  confirmCheckIn
} from '../services/ticket.service';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';

export const createTicketTypeController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { eventId } = req.params;
    const organizerId = authReq.user.id;
    const ticketTypeData = req.body;
    
    const ticketType = await createTicketType(ticketTypeData, eventId, organizerId);
    
    res.status(201).json({
      success: true,
      data: ticketType,
    });
  } catch (error) {
    next(error);
  }
};

export const getTicketTypesController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { eventId } = req.params;
    
    const ticketTypes = await getTicketTypes(eventId);
    
    res.status(200).json({
      success: true,
      count: ticketTypes.length,
      data: ticketTypes,
    });
  } catch (error) {
    next(error);
  }
};

export const updateTicketTypeController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { id } = req.params;
    const organizerId = authReq.user.id;
    const updateData = req.body;
    
    const ticketType = await updateTicketType(id, updateData, organizerId);
    
    res.status(200).json({
      success: true,
      data: ticketType,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteTicketTypeController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { id } = req.params;
    const organizerId = authReq.user.id;
    
    const result = await deleteTicketType(id, organizerId);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const generateTicketsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketTypeId } = req.params;
    const { quantity } = req.body;
    const organizerId = authReq.user.id;
    
    const result = await generateTickets(ticketTypeId, quantity, organizerId);
    
    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const purchaseTicketController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketTypeId } = req.params;
    const userId = authReq.user.id;
    
    const ticket = await purchaseTicket(ticketTypeId, userId);
    
    res.status(201).json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

export const getUserTicketsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const userId = authReq.user.id;
    
    const tickets = await getUserTickets(userId);
    
    res.status(200).json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyTicketController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticketCode, eventId } = req.body;

    const result = await verifyTicket(ticketCode, eventId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Preview step: non-mutating lookup of a scanned ticket so gate staff can
 * confirm the holder before checking them in. Accepts { eventId, ticketId }.
 */
export const getCheckInDetailsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticketId, eventId } = req.body;

    const result = await getCheckInDetails(ticketId, eventId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Commit step: marks a previewed ticket as checked in. Rejects (4xx) when the
 * ticket is unknown, not sold, or already checked in. Accepts { eventId, ticketId }.
 */
export const confirmCheckInController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticketId, eventId } = req.body;

    const result = await confirmCheckIn(ticketId, eventId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
