import { Request, Response, NextFunction } from 'express';
import { 
  createTicketType,
  getTicketTypes,
  updateTicketType,
  deleteTicketType,
  generateTickets,
  purchaseTicket,
  getPaymentOptions,
  getUserTickets,
  verifyTicket,
  getCheckInDetails,
  confirmCheckIn,
  refundTicket,
  cancelEvent,
  PurchasePaymentInput
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

    // Payment details forwarded to YeboPay. Optional for free (price 0) tickets;
    // the service rejects a priced purchase that arrives without them.
    const { paymentMethodId, providerCode, country, phone, cardToken, idempotencyKey } =
      req.body ?? {};
    const payment: PurchasePaymentInput = {
      paymentMethodId,
      providerCode,
      country,
      phone,
      cardToken,
      idempotencyKey,
    };

    const ticket = await purchaseTicket(ticketTypeId, userId, payment);

    // An asynchronous (mobile-money) charge comes back PENDING: the seat is held
    // and the ticket will be issued once payment confirms via webhook. Signal
    // this with 202 Accepted (not 201 Created) so the client shows "pending"
    // rather than treating a not-yet-issued ticket as bought.
    const isPending = (ticket as { pending?: boolean }).pending === true;
    res.status(isPending ? 202 : 201).json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List the YeboPay payment options for the buyer (country rails + saved
 * methods) so the app can render the payment picker without hardcoding
 * providers. GET /api/tickets/payment-options?country=SZ
 */
export const getPaymentOptionsController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    const options = await getPaymentOptions(authReq.user.id, country);

    res.status(200).json({
      success: true,
      data: options,
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
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketCode, eventId } = req.body;

    const result = await verifyTicket(ticketCode, eventId, {
      id: authReq.user.id,
      role: authReq.user.role,
    });

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
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketId, eventId } = req.body;

    const result = await getCheckInDetails(ticketId, eventId, {
      id: authReq.user.id,
      role: authReq.user.role,
    });

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
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketId, eventId } = req.body;

    const result = await confirmCheckIn(ticketId, eventId, {
      id: authReq.user.id,
      role: authReq.user.role,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Refund + cancel a SINGLE ticket. Only the owning organizer or an admin may do
 * this (enforced in the service via assertEventAccess). Returns the per-ticket
 * outcome; a failed YeboPay refund surfaces as a 502 (no false "refunded").
 * POST /api/tickets/refund/:ticketId  body: { reason? }
 */
export const refundTicketController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { ticketId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

    const result = await refundTicket(
      ticketId,
      { id: authReq.user.id, role: authReq.user.role },
      reason
    );

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cancel an EVENT: refund every sold ticket via YeboPay, mark each CANCELLED and
 * notify the holders. Only the owning organizer or an admin may do this. Returns
 * a per-ticket summary so any refund/notify failure is visible to the caller.
 * POST /api/tickets/events/:eventId/cancel
 */
export const cancelEventController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { eventId } = req.params;

    const result = await cancelEvent(eventId, {
      id: authReq.user.id,
      role: authReq.user.role,
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
