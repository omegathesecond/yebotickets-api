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
 * Shared Prisma include used for every check-in lookup so the holder, event,
 * and ticket-type are always available to render at the gate.
 */
const CHECK_IN_INCLUDE = {
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
} as const;

/**
 * Authenticated requester performing a check-in. Used to enforce that an
 * organizer can only check in tickets for their OWN events (admins may access
 * any event).
 */
type CheckInRequester = { id: string; role: string };

/**
 * Ensure the requester is allowed to check in tickets for this event. Throws
 * 404 if the event does not exist and 403 if a non-admin organizer does not own
 * it. Prevents cross-tenant check-in (IDOR) via a forged eventId in the body.
 */
const assertEventAccess = async (
  eventId: string,
  requester: CheckInRequester
): Promise<void> => {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizerId: true },
  });

  if (!event) {
    throw new ApiError('Event not found', 404);
  }

  if (requester.role !== 'admin' && event.organizerId !== requester.id) {
    throw new ApiError('You do not have permission to check in tickets for this event', 403);
  }
};

/**
 * Look up a ticket for check-in scoped to an event. The identifier may be the
 * ticket's database id (the scanner QR carries `{ ticketId, eventId }`) OR its
 * uniqueCode (used by the single-step /verify flow), so both are matched.
 */
const findTicketForCheckIn = async (ticketIdentifier: string, eventId: string) => {
  return prisma.ticket.findFirst({
    where: {
      eventId,
      OR: [
        { id: ticketIdentifier },
        { uniqueCode: ticketIdentifier },
      ],
    },
    include: CHECK_IN_INCLUDE,
  });
};

/**
 * Single source of truth for the double-check-in guard. Evaluates a ticket
 * WITHOUT mutating it and returns whether it may be checked in, plus the reason
 * when it may not. Reused by verifyTicket, getCheckInDetails and confirmCheckIn.
 */
const evaluateCheckIn = (
  ticket: { status: string; isCheckedIn: boolean } | null
): { valid: boolean; message: string } => {
  if (!ticket) {
    return { valid: false, message: 'Invalid ticket code' };
  }
  if (ticket.status !== 'sold') {
    return { valid: false, message: 'Ticket is not valid for check-in' };
  }
  if (ticket.isCheckedIn) {
    return { valid: false, message: 'Ticket has already been used for check-in' };
  }
  return { valid: true, message: 'Ticket is valid for check-in' };
};

/**
 * Flatten a ticket (with its relations) into the shape the gate scanner UI
 * reads directly: holder name, event name, ticket-type label and a `status`
 * where 'used' signals an already-checked-in ticket.
 */
const toCheckInTicketDto = (ticket: any) => ({
  id: ticket.id,
  uniqueCode: ticket.uniqueCode,
  name: ticket.user?.name ?? 'Guest',
  phoneNumber: ticket.user?.phoneNumber ?? null,
  eventId: ticket.eventId,
  eventName: ticket.event?.title ?? null,
  type: ticket.ticketType?.name ?? null,
  category: ticket.ticketType ? mapTicketType(ticket.ticketType.type) : null,
  status: ticket.isCheckedIn ? 'used' : mapTicketStatus(ticket.status),
  isCheckedIn: ticket.isCheckedIn,
  checkedInAt: ticket.checkedInAt ?? null,
});

/**
 * Verify ticket (single-step check-in). Verifies AND marks the ticket checked
 * in in one call. Preserved for the existing /api/tickets/verify consumer.
 * @param ticketCode Unique ticket code
 * @param eventId Event ID
 * @returns Check-in result
 */
export const verifyTicket = async (
  ticketCode: string,
  eventId: string,
  requester: CheckInRequester
): Promise<{ ticket: any; valid: boolean; message: string }> => {
  try {
    await assertEventAccess(eventId, requester);

    const ticket = await findTicketForCheckIn(ticketCode, eventId);

    const evaluation = evaluateCheckIn(ticket);
    if (!evaluation.valid) {
      return {
        ticket: ticket ? { ...ticket, status: mapTicketStatus(ticket.status) } : {},
        valid: false,
        message: evaluation.message,
      };
    }

    // Mark ticket as checked in
    const updatedTicket = await prisma.ticket.update({
      where: { id: ticket!.id },
      data: {
        isCheckedIn: true,
        checkedInAt: new Date(),
      },
      include: CHECK_IN_INCLUDE,
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
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to verify ticket', 500);
  }
};

/**
 * Get check-in details (preview step). Non-mutating lookup that returns the
 * ticket holder, event and current checked-in status so gate staff can confirm
 * identity BEFORE committing the check-in. Never marks the ticket as used.
 * @param ticketIdentifier Ticket database id or uniqueCode
 * @param eventId Event ID
 * @returns Holder/event details plus whether the ticket can be checked in now
 */
export const getCheckInDetails = async (
  ticketIdentifier: string,
  eventId: string,
  requester: CheckInRequester
): Promise<{ ticket: any; canCheckIn: boolean; message: string }> => {
  try {
    await assertEventAccess(eventId, requester);

    const ticket = await findTicketForCheckIn(ticketIdentifier, eventId);
    const evaluation = evaluateCheckIn(ticket);

    return {
      ticket: ticket ? toCheckInTicketDto(ticket) : {},
      canCheckIn: evaluation.valid,
      message: evaluation.message,
    };
  } catch (error) {
    console.error('Error in getCheckInDetails service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to get check-in details', 500);
  }
};

/**
 * Confirm check-in (commit step). Atomically marks a previewed ticket as
 * checked in and REJECTS (throws) when the ticket is unknown, not 'sold', or
 * already checked in — reusing the same guard as verifyTicket. The mutation is
 * a conditional updateMany so two scanners racing on the same ticket cannot
 * both succeed.
 * @param ticketIdentifier Ticket database id or uniqueCode
 * @param eventId Event ID
 * @returns Check-in result for the now checked-in ticket
 */
export const confirmCheckIn = async (
  ticketIdentifier: string,
  eventId: string,
  requester: CheckInRequester
): Promise<{ ticket: any; valid: boolean; message: string }> => {
  try {
    await assertEventAccess(eventId, requester);

    const ticket = await findTicketForCheckIn(ticketIdentifier, eventId);
    const evaluation = evaluateCheckIn(ticket);

    if (!evaluation.valid) {
      // Unknown code -> 404; not sold / already checked in -> 400.
      throw new ApiError(evaluation.message, ticket ? 400 : 404);
    }

    // Atomically claim the check-in: only succeeds while still un-checked-in and
    // sold, guarding against a double check-in race between preview and commit.
    const claim = await prisma.ticket.updateMany({
      where: { id: ticket!.id, isCheckedIn: false, status: 'sold' },
      data: { isCheckedIn: true, checkedInAt: new Date() },
    });

    if (claim.count === 0) {
      throw new ApiError('Ticket has already been used for check-in', 400);
    }

    const updatedTicket = await prisma.ticket.findUnique({
      where: { id: ticket!.id },
      include: CHECK_IN_INCLUDE,
    });

    return {
      ticket: updatedTicket ? toCheckInTicketDto(updatedTicket) : {},
      valid: true,
      message: 'Check-in successful',
    };
  } catch (error) {
    console.error('Error in confirmCheckIn service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to confirm check-in', 500);
  }
};
