import prisma from '../config/prisma';
import { 
  ITicket, 
  ITicketType, 
  TicketStatus,
  TicketType as TicketTypeEnum 
} from '../interfaces/ticket.interface';
import { ApiError } from '../middleware/error.middleware';
import crypto from 'crypto';

/**
 * Map Prisma enum to interface enum
 */
const mapTicketType = (type: string): TicketTypeEnum => {
  const mapping: Record<string, TicketTypeEnum> = {
    standard: TicketTypeEnum.STANDARD,
    vip: TicketTypeEnum.VIP,
    early_bird: TicketTypeEnum.EARLY_BIRD,
    group: TicketTypeEnum.GROUP,
  };
  return mapping[type] || TicketTypeEnum.STANDARD;
};

const mapTicketStatus = (status: string): TicketStatus => {
  const mapping: Record<string, TicketStatus> = {
    available: TicketStatus.AVAILABLE,
    sold: TicketStatus.SOLD,
    reserved: TicketStatus.RESERVED,
    cancelled: TicketStatus.CANCELLED,
  };
  return mapping[status] || TicketStatus.AVAILABLE;
};

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
) => {
  try {
    // First verify the event belongs to this organizer
    const event = await prisma.event.findFirst({
      where: {
        id: eventId,
        organizerId,
      },
    });

    if (!event) {
      throw new ApiError('Event not found or you do not have permission to create tickets for it', 404);
    }

    // Map the type enum
    const typeValue = ticketTypeData.type?.toLowerCase() || 'standard';

    // Create the ticket type
    const ticketType = await prisma.ticketType.create({
      data: {
        name: ticketTypeData.name!,
        description: ticketTypeData.description || null,
        price: ticketTypeData.price!,
        quantity: ticketTypeData.quantity!,
        eventId,
        type: typeValue as any,
        saleStartDate: new Date(ticketTypeData.saleStartDate!),
        saleEndDate: new Date(ticketTypeData.saleEndDate!),
      },
    });

    return {
      ...ticketType,
      type: mapTicketType(ticketType.type),
    };
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
export const getTicketTypes = async (eventId: string) => {
  try {
    const ticketTypes = await prisma.ticketType.findMany({
      where: { eventId },
    });
    return ticketTypes.map(tt => ({
      ...tt,
      type: mapTicketType(tt.type),
    }));
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
) => {
  try {
    // Find ticket type
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
    });
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await prisma.event.findFirst({
      where: {
        id: ticketType.eventId,
        organizerId,
      },
    });

    if (!event) {
      throw new ApiError('You do not have permission to update this ticket type', 403);
    }

    // Build update object
    const updates: any = {};
    if (updateData.name) updates.name = updateData.name;
    if (updateData.description !== undefined) updates.description = updateData.description;
    if (updateData.price !== undefined) updates.price = updateData.price;
    if (updateData.quantity !== undefined) updates.quantity = updateData.quantity;
    if (updateData.type) updates.type = updateData.type.toLowerCase();
    if (updateData.saleStartDate) updates.saleStartDate = new Date(updateData.saleStartDate);
    if (updateData.saleEndDate) updates.saleEndDate = new Date(updateData.saleEndDate);

    // Update the ticket type
    const updated = await prisma.ticketType.update({
      where: { id: ticketTypeId },
      data: updates,
    });

    return {
      ...updated,
      type: mapTicketType(updated.type),
    };
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
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
    });
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await prisma.event.findFirst({
      where: {
        id: ticketType.eventId,
        organizerId,
      },
    });

    if (!event) {
      throw new ApiError('You do not have permission to delete this ticket type', 403);
    }

    // Check if there are any tickets of this type that are already sold
    const soldTicketsCount = await prisma.ticket.count({
      where: {
        ticketTypeId,
        status: { in: ['sold', 'reserved'] },
      },
    });

    if (soldTicketsCount > 0) {
      throw new ApiError('Cannot delete ticket type that has sold tickets', 400);
    }

    // Delete all available tickets of this type first
    await prisma.ticket.deleteMany({
      where: {
        ticketTypeId,
        status: 'available',
      },
    });

    // Delete the ticket type
    await prisma.ticketType.delete({
      where: { id: ticketTypeId },
    });

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
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
    });
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Verify the event belongs to this organizer
    const event = await prisma.event.findFirst({
      where: {
        id: ticketType.eventId,
        organizerId,
      },
    });

    if (!event) {
      throw new ApiError('You do not have permission to generate tickets for this event', 403);
    }

    // Generate tickets
    const ticketsToCreate: {
      ticketTypeId: string;
      eventId: string;
      status: 'available';
      uniqueCode: string;
    }[] = [];
    for (let i = 0; i < quantity; i++) {
      ticketsToCreate.push({
        ticketTypeId,
        eventId: ticketType.eventId,
        status: 'available',
        uniqueCode: crypto.randomBytes(8).toString('hex').toUpperCase(),
      });
    }

    const result = await prisma.ticket.createMany({
      data: ticketsToCreate,
    });

    return { 
      message: 'Tickets generated successfully', 
      count: result.count,
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
) => {
  try {
    // Find ticket type
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
    });
    
    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // Find an available ticket
    const availableTicket = await prisma.ticket.findFirst({
      where: {
        ticketTypeId,
        status: 'available',
      },
    });

    if (!availableTicket) {
      throw new ApiError('No tickets available for this ticket type', 400);
    }

    // Update the ticket
    const ticket = await prisma.ticket.update({
      where: { id: availableTicket.id },
      data: {
        userId,
        status: 'sold',
        purchaseDate: new Date(),
      },
    });

    return {
      ...ticket,
      status: mapTicketStatus(ticket.status),
    };
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
export const getUserTickets = async (userId: string) => {
  try {
    const tickets = await prisma.ticket.findMany({
      where: { userId },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            startDate: true,
            locationAddress: true,
            locationCity: true,
            locationCountry: true,
          },
        },
        ticketType: {
          select: {
            id: true,
            name: true,
            price: true,
            type: true,
          },
        },
      },
    });
    
    return tickets.map(t => ({
      ...t,
      status: mapTicketStatus(t.status),
      ticketType: t.ticketType ? {
        ...t.ticketType,
        type: mapTicketType(t.ticketType.type),
      } : null,
    }));
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
): Promise<{ ticket: any; valid: boolean; message: string }> => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: {
        uniqueCode: ticketCode,
        eventId,
      },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            startDate: true,
            endDate: true,
          },
        },
        ticketType: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
          },
        },
      },
    });

    if (!ticket) {
      return {
        ticket: {},
        valid: false,
        message: 'Invalid ticket code',
      };
    }

    if (ticket.status !== 'sold') {
      return {
        ticket: {
          ...ticket,
          status: mapTicketStatus(ticket.status),
        },
        valid: false,
        message: 'Ticket is not valid for check-in',
      };
    }

    if (ticket.isCheckedIn) {
      return {
        ticket: {
          ...ticket,
          status: mapTicketStatus(ticket.status),
        },
        valid: false,
        message: 'Ticket has already been used for check-in',
      };
    }

    // Mark ticket as checked in
    const updatedTicket = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        isCheckedIn: true,
        checkedInAt: new Date(),
      },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            startDate: true,
            endDate: true,
          },
        },
        ticketType: {
          select: {
            id: true,
            name: true,
            type: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            phoneNumber: true,
          },
        },
      },
    });

    return {
      ticket: {
        ...updatedTicket,
        status: mapTicketStatus(updatedTicket.status),
      },
      valid: true,
      message: 'Check-in successful',
    };
  } catch (error) {
    console.error('Error in verifyTicket service:', error);
    throw new ApiError('Failed to verify ticket', 500);
  }
};
