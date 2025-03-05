import { TicketType, Ticket } from '../models/ticket.model';
import Event from '../models/event.model';
import { 
  ITicket, 
  ITicketType, 
  TicketStatus 
} from '../interfaces/ticket.interface';
import { ApiError } from '../middleware/error.middleware';
import { Types } from 'mongoose';
import crypto from 'crypto';

/**
 * Create a new ticket type for an event
 * @param ticketTypeData Ticket type data
 * @param eventId Event ID
 * @param organizerId Organizer ID for authorization
 * @returns Created ticket type
 */
export const createTicketType = async (
  ticketTypeData: Partial<ITicketType>, 
  eventId: string,
  organizerId: string
): Promise<ITicketType> => {
  try {
    // First verify the event belongs to this organizer
    const event = await Event.findOne({
      _id: eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('Event not found or you do not have permission to create tickets for it', 404);
    }

    // Create the ticket type
    const ticketType = await TicketType.create({
      ...ticketTypeData,
      eventId,
    });

    return ticketType;
  } catch (error) {
    console.error('Error in createTicketType service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to create ticket type', 500);
  }
};

/**
 * Get all ticket types for an event
 * @param eventId Event ID
 * @returns List of ticket types
 */
export const getTicketTypes = async (eventId: string): Promise<ITicketType[]> => {
  try {
    const ticketTypes = await TicketType.find({ eventId });
    return ticketTypes;
  } catch (error) {
    console.error('Error in getTicketTypes service:', error);
    throw new ApiError('Failed to fetch ticket types', 500);
  }
};

/**
 * Update a ticket type
 * @param ticketTypeId Ticket type ID
 * @param updateData Update data
 * @param organizerId Organizer ID for authorization
 * @returns Updated ticket type
 */
export const updateTicketType = async (
  ticketTypeId: string,
  updateData: Partial<ITicketType>,
  organizerId: string
): Promise<ITicketType> => {
  try {
    // Find ticket type
    const ticketType = await TicketType.findById(ticketTypeId);
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await Event.findOne({
      _id: ticketType.eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('You do not have permission to update this ticket type', 403);
    }

    // Update the ticket type
    Object.assign(ticketType, updateData);
    await ticketType.save();

    return ticketType;
  } catch (error) {
    console.error('Error in updateTicketType service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to update ticket type', 500);
  }
};

/**
 * Delete a ticket type
 * @param ticketTypeId Ticket type ID
 * @param organizerId Organizer ID for authorization
 * @returns Success message
 */
export const deleteTicketType = async (
  ticketTypeId: string,
  organizerId: string
): Promise<{ message: string }> => {
  try {
    // Find ticket type
    const ticketType = await TicketType.findById(ticketTypeId);
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await Event.findOne({
      _id: ticketType.eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('You do not have permission to delete this ticket type', 403);
    }

    // Check if there are any tickets of this type that are already sold
    const soldTicketsCount = await Ticket.countDocuments({
      ticketTypeId,
      status: { $in: [TicketStatus.SOLD, TicketStatus.RESERVED] },
    });

    if (soldTicketsCount > 0) {
      throw new ApiError('Cannot delete ticket type that has sold tickets', 400);
    }

    // Delete all available tickets of this type
    await Ticket.deleteMany({
      ticketTypeId,
      status: TicketStatus.AVAILABLE,
    });

    // Delete the ticket type
    await TicketType.deleteOne({ _id: ticketTypeId });

    return { message: 'Ticket type deleted successfully' };
  } catch (error) {
    console.error('Error in deleteTicketType service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to delete ticket type', 500);
  }
};

/**
 * Generate tickets for a ticket type
 * @param ticketTypeId Ticket type ID
 * @param quantity Number of tickets to generate
 * @param organizerId Organizer ID for authorization
 * @returns Success message with count
 */
export const generateTickets = async (
  ticketTypeId: string,
  quantity: number,
  organizerId: string
): Promise<{ message: string; count: number }> => {
  try {
    // Find ticket type
    const ticketType = await TicketType.findById(ticketTypeId);
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await Event.findOne({
      _id: ticketType.eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('You do not have permission to generate tickets for this event', 403);
    }

    // Generate tickets
    const ticketsToCreate: {
      ticketTypeId: string;
      eventId: Types.ObjectId;
      status: TicketStatus;
      uniqueCode?: string;
    }[] = [];
    
    for (let i = 0; i < quantity; i++) {
      ticketsToCreate.push({
        ticketTypeId,
        eventId: ticketType.eventId,
        status: TicketStatus.AVAILABLE,
        uniqueCode: crypto.randomBytes(8).toString('hex')
      });
    }

    const createdTickets = await Ticket.insertMany(ticketsToCreate);

    return { 
      message: 'Tickets generated successfully', 
      count: createdTickets.length 
    };
  } catch (error) {
    console.error('Error in generateTickets service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to generate tickets', 500);
  }
};

/**
 * Purchase a ticket
 * @param ticketTypeId Ticket type ID
 * @param userId User ID
 * @returns Purchased ticket
 */
export const purchaseTicket = async (
  ticketTypeId: string,
  userId: string
): Promise<ITicket> => {
  try {
    // Find ticket type
    const ticketType = await TicketType.findById(ticketTypeId);
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Check if tickets are available
    const availableTicket = await Ticket.findOne({
      ticketTypeId,
      status: TicketStatus.AVAILABLE,
    });

    if (!availableTicket) {
      throw new ApiError('No tickets available for this ticket type', 400);
    }

    // Update the ticket
    availableTicket.userId = new Types.ObjectId(userId);
    availableTicket.status = TicketStatus.SOLD;
    availableTicket.purchaseDate = new Date();
    await availableTicket.save();

    return availableTicket;
  } catch (error) {
    console.error('Error in purchaseTicket service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to purchase ticket', 500);
  }
};

/**
 * Get user's tickets
 * @param userId User ID
 * @returns List of tickets
 */
export const getUserTickets = async (userId: string): Promise<ITicket[]> => {
  try {
    const tickets = await Ticket.find({ userId })
      .populate('eventId', 'title startDate location')
      .populate('ticketTypeId', 'name price type');
    
    return tickets;
  } catch (error) {
    console.error('Error in getUserTickets service:', error);
    throw new ApiError('Failed to fetch user tickets', 500);
  }
};

/**
 * Verify ticket (for check-in)
 * @param ticketCode Unique ticket code
 * @param eventId Event ID
 * @returns Check-in result
 */
export const verifyTicket = async (
  ticketCode: string,
  eventId: string
): Promise<{ ticket: ITicket; valid: boolean; message: string }> => {
  try {
    const ticket = await Ticket.findOne({
      uniqueCode: ticketCode,
      eventId,
    })
    .populate('eventId', 'title startDate endDate')
    .populate('ticketTypeId', 'name type')
    .populate('userId', 'name phoneNumber');

    if (!ticket) {
      return {
        ticket: {} as ITicket,
        valid: false,
        message: 'Invalid ticket code',
      };
    }

    if (ticket.status !== TicketStatus.SOLD) {
      return {
        ticket,
        valid: false,
        message: 'Ticket is not valid for check-in',
      };
    }

    if (ticket.isCheckedIn) {
      return {
        ticket,
        valid: false,
        message: 'Ticket has already been used for check-in',
      };
    }

    // Mark ticket as checked in
    ticket.isCheckedIn = true;
    ticket.checkedInAt = new Date();
    await ticket.save();

    return {
      ticket,
      valid: true,
      message: 'Check-in successful',
    };
  } catch (error) {
    console.error('Error in verifyTicket service:', error);
    throw new ApiError('Failed to verify ticket', 500);
  }
}; 