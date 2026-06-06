import prisma from '../config/prisma';
import { 
  ITicket, 
  ITicketType, 
  TicketStatus,
  TicketType as TicketTypeEnum 
} from '../interfaces/ticket.interface';
import { ApiError } from '../middleware/error.middleware';
import crypto from 'crypto';
import {
  buildTicketQrPayload,
  generateTicketQrDataUrl,
  generateTicketQrBuffer,
} from './qr.service';
import { sendImageMessage } from './whatsapp.service';

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
 * Prisma include used when issuing a ticket on purchase so we have everything
 * needed to render the QR and the delivery message: the event (title, date,
 * venue), the ticket-type label, and the buyer's phone number.
 */
const PURCHASE_INCLUDE = {
  event: {
    select: {
      id: true,
      title: true,
      startDate: true,
      endDate: true,
      locationAddress: true,
      locationCity: true,
      locationCountry: true,
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
 * Outcome of attempting to deliver an issued ticket to the buyer. `status:
 * 'failed'` is returned (never thrown) so the purchase response can surface the
 * failure loudly without pretending the message was sent — the buyer still
 * receives the QR inline in the response.
 */
export interface TicketDeliveryResult {
  channel: 'whatsapp';
  status: 'sent' | 'failed';
  error?: string;
}

/** Normalise an unknown caught value into a readable message. */
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Build a single-line venue string from the event location fields. */
const formatVenue = (event: {
  locationAddress?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
}): string =>
  [event.locationAddress, event.locationCity, event.locationCountry]
    .filter(Boolean)
    .join(', ') || 'Venue to be announced';

/** Format the event start date for the buyer (Eswatini local time). */
const formatEventDate = (date: Date): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Africa/Mbabane',
    }).format(date);
  } catch {
    return date.toUTCString();
  }
};

/**
 * Compose the human-readable ticket message that accompanies the QR image,
 * including event title, date, venue, ticket type and the unique code.
 */
const buildTicketMessage = (ticket: any): string => {
  const lines = [
    `🎟️ Your ticket for ${ticket.event?.title ?? 'your event'}`,
    '',
    `📅 ${ticket.event?.startDate ? formatEventDate(ticket.event.startDate) : 'Date to be announced'}`,
    `📍 ${formatVenue(ticket.event ?? {})}`,
  ];
  if (ticket.ticketType?.name) {
    lines.push(`🎫 ${ticket.ticketType.name}`);
  }
  lines.push(`🔑 Ticket code: ${ticket.uniqueCode}`);
  lines.push('');
  lines.push('Show this QR code at the gate for entry.');
  return lines.join('\n');
};

/**
 * Attach the QR (data URL) and the decoded payload to a ticket object so any
 * client can render it inline. Used by both the purchase response and
 * GET /api/tickets/my-tickets.
 */
const withQrFields = async <T extends { eventId: string; uniqueCode: string }>(
  ticket: T
): Promise<T & { qrCode: string; qrPayload: ReturnType<typeof buildTicketQrPayload> }> => ({
  ...ticket,
  qrCode: await generateTicketQrDataUrl(ticket.eventId, ticket.uniqueCode),
  qrPayload: buildTicketQrPayload(ticket.eventId, ticket.uniqueCode),
});

/**
 * Deliver the issued ticket QR + details to the buyer's phone via WhatsApp.
 * Failures are caught and returned as `status: 'failed'` (with the reason) so
 * the caller can warn the buyer rather than silently pretend delivery worked.
 */
const deliverTicketToBuyer = async (ticket: any): Promise<TicketDeliveryResult> => {
  const phoneNumber = ticket.user?.phoneNumber;
  if (!phoneNumber) {
    return {
      channel: 'whatsapp',
      status: 'failed',
      error: 'Buyer has no phone number on file',
    };
  }

  try {
    const qrBuffer = await generateTicketQrBuffer(ticket.eventId, ticket.uniqueCode);
    await sendImageMessage(phoneNumber, qrBuffer, buildTicketMessage(ticket));
    return { channel: 'whatsapp', status: 'sent' };
  } catch (error) {
    console.error('Failed to deliver ticket via WhatsApp:', error);
    return {
      channel: 'whatsapp',
      status: 'failed',
      error: errorMessage(error),
    };
  }
};

/**
 * Atomically claim exactly one available ticket of a type for a buyer.
 *
 * The race this guards against: two buyers `findFirst` the SAME available row,
 * then both write it by id — the second write silently steals the first buyer's
 * ticket and capacity can be exceeded. The fix folds the availability check INTO
 * the write: a conditional `updateMany` whose WHERE still requires
 * `status: 'available'` AND `userId: null`. The database evaluates that against
 * the live row, so for a given row exactly one concurrent writer matches
 * (`count === 1`) and every other sees `count === 0` — a lock-free
 * compare-and-set, mirroring the gate check-in guard in `confirmCheckIn`.
 *
 * A lost race (`count === 0`) does NOT fail the buyer outright: another row may
 * still be free, so we loop to the next candidate. The loop is naturally
 * bounded — each lost race means that row is now `sold`, so the next `findFirst`
 * (which filters `status: 'available'`) can never return it again; the visible
 * pool strictly shrinks until we claim a row or it is genuinely empty.
 *
 * @returns the claimed ticket (with PURCHASE_INCLUDE relations), or `null` when
 *   no ticket of this type is available.
 */
const claimAvailableTicket = async (ticketTypeId: string, userId: string) => {
  for (;;) {
    const candidate = await prisma.ticket.findFirst({
      where: { ticketTypeId, status: 'available', userId: null },
      select: { id: true },
    });

    if (!candidate) {
      return null;
    }

    // Conditional claim: only flips the row while it is STILL available and
    // unowned. count === 1 -> we won; count === 0 -> another buyer beat us to
    // this exact row between our find and our write.
    const claim = await prisma.ticket.updateMany({
      where: { id: candidate.id, status: 'available', userId: null },
      data: {
        userId,
        status: 'sold',
        purchaseDate: new Date(),
      },
    });

    if (claim.count === 0) {
      continue; // lost this row; try the next available candidate
    }

    // We own the row; no other writer can match the guard now, so this read
    // returns our committed sale with the relations needed for delivery.
    return prisma.ticket.findUnique({
      where: { id: candidate.id },
      include: PURCHASE_INCLUDE,
    });
  }
};

/**
 * Purchase a ticket
 *
 * On success this also: generates a QR encoding the canonical
 * { eventId, ticketId: uniqueCode } payload the gate scanner parses, delivers
 * the ticket (QR + event details) to the buyer's phone via WhatsApp, and
 * returns the QR (data URL) plus an explicit `delivery` status. A failed
 * delivery does NOT roll back the (paid) purchase and is NOT swallowed — it is
 * surfaced via `delivery.status: 'failed'` so the client can warn the buyer,
 * who still has the QR inline in this response.
 *
 * The claim itself is atomic (see `claimAvailableTicket`): concurrent buyers can
 * never be allocated the same Ticket row and the pool can never be oversold.
 *
 * @param ticketTypeId Ticket type ID
 * @param userId User ID
 * @returns Purchased ticket with qrCode, qrPayload and delivery status
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

    // Atomically claim one available row (pulling in event + buyer details
    // needed for delivery). null means the pool is genuinely exhausted.
    const ticket = await claimAvailableTicket(ticketTypeId, userId);

    if (!ticket) {
      throw new ApiError('No tickets available for this ticket type', 400);
    }

    // Deliver QR + details to the buyer; result captures any failure loudly.
    const delivery = await deliverTicketToBuyer(ticket);

    const withQr = await withQrFields(ticket);

    return {
      ...withQr,
      status: mapTicketStatus(ticket.status),
      ticketType: ticket.ticketType
        ? { ...ticket.ticketType, type: mapTicketType(ticket.ticketType.type) }
        : null,
      delivery,
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
    
    return Promise.all(
      tickets.map(async t => ({
        ...(await withQrFields(t)),
        status: mapTicketStatus(t.status),
        ticketType: t.ticketType ? {
          ...t.ticketType,
          type: mapTicketType(t.ticketType.type),
        } : null,
      }))
    );
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
