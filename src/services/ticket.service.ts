import { assertDateInterval } from '../utils/dateInterval';
import type { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { 
  ITicket, 
  ITicketType, 
  TicketStatus,
  TicketType as TicketTypeEnum 
} from '../interfaces/ticket.interface';
import { ApiError } from '../middleware/error.middleware';
import crypto from 'crypto';
import { YeboLinkSendError } from './yebolink.client';
import {
  buildTicketQrPayload,
  generateTicketQrDataUrl,
} from './qr.service';
import { sendTextMessage, sendEmailMessage } from './comms.service';
import {
  createCharge,
  getCharge,
  listPaymentOptions,
  refundCharge,
  YeboPayHttpError,
  type PaymentOptionsResponse,
} from './yebopay.service';

/** Currency + default country tickets are priced/charged in (Eswatini). */
const TICKET_CURRENCY = 'SZL';
const DEFAULT_COUNTRY = 'SZ';

/**
 * How long a reservation may sit unconfirmed before the reclaim sweep asks
 * YeboPay what really happened to its charge. Mobile-money (the dominant rail
 * here) is asynchronous: `createCharge` returns PENDING and the buyer approves a
 * USSD prompt seconds-to-minutes later, settling via a `charge.succeeded`
 * webhook. We must NOT reclaim a still-live PENDING hold (the money could still
 * land — that is the exact silent-failure this task fixes), so the sweep is
 * authoritative: it polls `GET /v1/charges/:id` and only reclaims a hold whose
 * charge YeboPay reports FAILED, finalizes one reported SUCCEEDED (reconciling a
 * missed webhook), and retains PENDING payment references at any age.
 * The hard cutoff only reclaims abandoned, unreferenced holds. PROCESSING
 * holds represent an in-flight gateway call and require reconciliation if the
 * process crashes; they must never be recycled underneath a live charge.
 */
const RESERVATION_TTL_MS = Number.parseInt(process.env['RESERVATION_TTL_MS'] || '', 10) || 15 * 60 * 1000;
const RESERVATION_HARD_EXPIRY_MS =
  Number.parseInt(process.env['RESERVATION_HARD_EXPIRY_MS'] || '', 10) || 60 * 60 * 1000;
/** Cap how many stale holds one lazy sweep resolves, to bound purchase latency. */
export const RECLAIM_BATCH = 20;

/**
 * How the buyer is paying, forwarded to YeboPay. Either a saved
 * `paymentMethodId`, OR a one-off `providerCode` (+ the family's field: `phone`
 * for mobile money, `cardToken` for card). `country` defaults to SZ.
 * `idempotencyKey` lets the client make a retry safe against double-charging —
 * the buyer app sends a fresh key per ticket so each ticket is charged once.
 */
export interface PurchasePaymentInput {
  paymentMethodId?: string;
  providerCode?: string;
  country?: string;
  phone?: string;
  cardToken?: string;
  idempotencyKey?: string;
}

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
  assertDateInterval(ticketTypeData.saleStartDate, ticketTypeData.saleEndDate, 'Sale end date must be after sale start date');
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
 * Count still-purchasable tickets per ticket type — the same `status:
 * 'available', userId: null` shape `claimAvailableTickets`/its
 * `availableRemaining` fallback use, so what a buyer sees here always agrees
 * with what a purchase attempt will actually find. `quantity` on TicketType is
 * the organizer's original capacity and never shrinks as tickets sell, so it
 * cannot be used to tell a buyer whether anything is left.
 */
export const getAvailableQuantities = async (ticketTypeIds: string[]): Promise<Map<string, number>> => {
  if (ticketTypeIds.length === 0) return new Map();
  const counts = await prisma.ticket.groupBy({
    by: ['ticketTypeId'],
    where: { ticketTypeId: { in: ticketTypeIds }, status: 'available', userId: null },
    _count: { _all: true },
  });
  return new Map(counts.map(c => [c.ticketTypeId, c._count._all]));
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
    const availableQuantities = await getAvailableQuantities(ticketTypes.map(tt => tt.id));
    return ticketTypes.map(tt => ({
      ...tt,
      type: mapTicketType(tt.type),
      availableQuantity: availableQuantities.get(tt.id) ?? 0,
    }));
  } catch (error) {
    console.error('Error in getTicketTypes service:', error);
    throw new ApiError('Failed to fetch ticket types', 500);
  }
};

/** Serialize inventory creation and capacity edits on the tier row. Count every
 * record: selling, reserving or cancelling a ticket never frees a seat here. */
const assertInventoryCapacity = async (
  tx: Prisma.TransactionClient,
  ticketTypeId: string,
  capacity: number,
  additional = 0
) => {
  if (!Number.isSafeInteger(capacity) || capacity < 0 ||
      !Number.isSafeInteger(additional) || additional < 0) {
    throw new ApiError('Ticket capacity and generation quantity must be non-negative integers', 400);
  }
  const existing = await tx.ticket.count({ where: { ticketTypeId } });
  if (existing + additional > capacity) {
    throw new ApiError(
      `Ticket tier capacity exceeded: ${existing} tickets already exist; capacity is ${capacity}, remaining capacity is ${Math.max(0, capacity - existing)}`,
      400
    );
  }
};

const lockTicketTier = async (tx: Prisma.TransactionClient, ticketTypeId: string) => {
  await tx.$queryRaw`SELECT "id" FROM "TicketType" WHERE "id" = ${ticketTypeId} FOR UPDATE`;
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
    return await prisma.$transaction(async (tx) => {
      await lockTicketTier(tx, ticketTypeId);
      // Find ticket type
      const ticketType = await tx.ticketType.findUnique({
        where: { id: ticketTypeId },
      });

      if (!ticketType) {
        throw new ApiError('Ticket type not found', 404);
      }

      // Verify the event belongs to this organizer
      const event = await tx.event.findFirst({
        where: {
          id: ticketType.eventId,
          organizerId,
        },
      });

      if (!event) {
        throw new ApiError('You do not have permission to update this ticket type', 403);
      }

      assertDateInterval(
        updateData.saleStartDate === undefined ? ticketType.saleStartDate : updateData.saleStartDate,
        updateData.saleEndDate === undefined ? ticketType.saleEndDate : updateData.saleEndDate,
        'Sale end date must be after sale start date'
      );
      await assertInventoryCapacity(tx, ticketTypeId, updateData.quantity ?? ticketType.quantity);

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
      const updated = await tx.ticketType.update({
        where: { id: ticketTypeId },
        data: updates,
      });

      return {
        ...updated,
        type: mapTicketType(updated.type),
      };
    });
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
    return await prisma.$transaction(async (tx) => {
      await lockTicketTier(tx, ticketTypeId);
      // Find ticket type
      const ticketType = await tx.ticketType.findUnique({
        where: { id: ticketTypeId },
      });

      if (!ticketType) {
        throw new ApiError('Ticket type not found', 404);
      }

      // Verify the event belongs to this organizer
      const event = await tx.event.findFirst({
        where: {
          id: ticketType.eventId,
          organizerId,
        },
      });

      if (!event) {
        throw new ApiError('You do not have permission to generate tickets for this event', 403);
      }

      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ApiError('Generation quantity must be a positive integer', 400);
      }
      await assertInventoryCapacity(tx, ticketTypeId, ticketType.quantity, quantity);

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

      const result = await tx.ticket.createMany({
        data: ticketsToCreate,
      });

      return {
        message: 'Tickets generated successfully',
        count: result.count,
      };
    });
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
      isCancelled: true,
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
      email: true,
    },
  },
} as const;

/**
 * Outcome of attempting to deliver an issued ORDER to the buyer. `status:
 * 'failed'` is returned (never thrown) so the purchase response can surface the
 * failure loudly without pretending the message was sent — the buyer still
 * receives the QR(s) inline in the response.
 */
export interface TicketDeliveryResult {
  /** The channel that actually delivered (or was attempted last on failure). */
  channel?: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'suppressed';
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
 * Compose the human-readable message that accompanies the QR image(s) for a
 * whole ORDER — one or more tickets of the same type, bought together in one
 * purchase call — including event title, date, venue, ticket type and every
 * ticket's unique code. A single-ticket order reads exactly like the previous
 * per-ticket copy; a multi-ticket order lists every code so the buyer gets ONE
 * message covering the whole group instead of one send per ticket.
 */
const buildOrderMessage = (tickets: any[]): string => {
  const first = tickets[0];
  const multi = tickets.length > 1;
  const lines = [
    multi
      ? `🎟️ Your ${tickets.length} tickets for ${first.event?.title ?? 'your event'}`
      : `🎟️ Your ticket for ${first.event?.title ?? 'your event'}`,
    '',
    `📅 ${first.event?.startDate ? formatEventDate(first.event.startDate) : 'Date to be announced'}`,
    `📍 ${formatVenue(first.event ?? {})}`,
  ];
  if (first.ticketType?.name) {
    lines.push(`🎫 ${first.ticketType.name}`);
  }
  lines.push('');
  if (multi) {
    lines.push('Ticket codes:');
    tickets.forEach((t) => lines.push(`🔑 ${t.uniqueCode}`));
  } else {
    lines.push(`🔑 Ticket code: ${first.uniqueCode}`);
  }
  lines.push('');
  lines.push(
    multi ? 'Show each QR code at the gate for entry.' : 'Show this QR code at the gate for entry.'
  );
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
 * Compose the HTML body for the ticket-delivery email covering the WHOLE
 * order: the shared order details as text, plus every ticket's QR rendered
 * inline (data URI) so a multi-ticket order still hands the buyer every
 * scannable code even over the fallback channel. Email clients that strip
 * data-URI images still show every ticket code in the text, and every
 * scannable QR is always available inline in the purchase API response too.
 */
const buildOrderEmailHtml = async (tickets: any[]): Promise<string> => {
  const details = buildOrderMessage(tickets)
    .split('\n')
    .map((line) => (line ? `<p style="margin:4px 0">${line}</p>` : ''))
    .join('');
  const qrImages = await Promise.all(
    tickets.map((t) => generateTicketQrDataUrl(t.eventId, t.uniqueCode))
  );
  const imagesHtml = qrImages
    .map(
      (dataUrl) =>
        `<div style="margin-top:16px"><img src="${dataUrl}" alt="Ticket QR code" width="220" height="220" /></div>`
    )
    .join('');
  return `<div style="font-family:system-ui,Arial,sans-serif;color:#111">${details}${imagesHtml}</div>`;
};

/**
 * Deliver an issued ORDER's ticket details + codes to the buyer over YeboLink
 * (the canonical Omevision comms gateway) — exactly ONE message for the whole
 * order, never one send per ticket. Primary channel is WhatsApp; if that fails
 * (or the buyer has no phone on file) we fall back to email when an address is
 * available. The QR(s) are always returned inline in the purchase response, so
 * a messaging failure never strands the buyer.
 *
 * Failures are caught and returned as `status: 'failed'` (never thrown) so the
 * caller can warn the buyer rather than silently pretend delivery worked — a
 * paid purchase is never rolled back over a comms hiccup, but the failure is
 * surfaced, not swallowed.
 */
const deliverOrderToBuyer = async (tickets: any[]): Promise<TicketDeliveryResult> => {
  const first = tickets[0];
  const phoneNumber = first.user?.phoneNumber;
  const email = first.user?.email;
  const text = buildOrderMessage(tickets);
  const errors: string[] = [];

  // Primary channel: WhatsApp via YeboLink.
  if (phoneNumber) {
    try {
      await sendTextMessage(phoneNumber, text);
      return { channel: 'whatsapp', status: 'sent' };
    } catch (error) {
      console.error('Failed to deliver order via WhatsApp:', error);
      if (!(error instanceof YeboLinkSendError) || error.ambiguous) {
        return { channel: 'whatsapp', status: 'unknown', error: 'Delivery acknowledgement was lost. A message may already have been sent.' };
      }
      errors.push(`whatsapp: ${errorMessage(error)}`);
    }
  } else {
    errors.push('whatsapp: buyer has no phone number on file');
  }

  // Fallback channel: email via YeboLink (only if the buyer has one on file).
  if (email) {
    try {
      const html = await buildOrderEmailHtml(tickets);
      await sendEmailMessage(
        email,
        tickets.length > 1
          ? `Your ${tickets.length} tickets for ${first.event?.title ?? 'your event'}`
          : `Your ticket for ${first.event?.title ?? 'your event'}`,
        html,
        text
      );
      return { channel: 'email', status: 'sent' };
    } catch (error) {
      console.error('Failed to deliver order via email:', error);
      if (!(error instanceof YeboLinkSendError) || error.ambiguous) {
        return { channel: 'email', status: 'unknown', error: 'Delivery acknowledgement was lost. A message may already have been sent.' };
      }
      errors.push(`email: ${errorMessage(error)}`);
    }
  }

  // No channel succeeded — report failed on the last channel we could attempt.
  return {
    channel: email ? 'email' : 'whatsapp',
    status: 'failed',
    error: errors.join('; '),
  };
};

/**
 * Atomically claim up to `quantity` available tickets of a type for a buyer,
 * flipping each to the given target `status` (and applying any extra `data`) —
 * reserving ALL of them or NONE (an order is never partially reserved).
 *
 * The per-row race this guards against: two buyers `findFirst` the SAME
 * available row, then both write it by id — the second write silently steals
 * the first buyer's ticket and capacity can be exceeded. The fix folds the
 * availability check INTO the write: a conditional `updateMany` whose WHERE
 * still requires `status: 'available'` AND `userId: null`. The database
 * evaluates that against the live row, so for a given row exactly one
 * concurrent writer matches (`count === 1`) and every other sees `count === 0`
 * — a lock-free compare-and-set, mirroring the gate check-in guard in
 * `confirmCheckIn`. A lost race on one row does NOT fail the claim outright:
 * another row may still be free, so we loop to the next candidate. The loop is
 * naturally bounded — each lost race means that row is now taken, so the next
 * `findFirst` (which filters `status: 'available'`) can never return it again;
 * the visible pool strictly shrinks until we claim enough rows or it runs out.
 *
 * If fewer than `quantity` rows can be claimed, every row we DID claim in this
 * attempt is released straight back to the pool (never left partially
 * reserved) and the caller gets `tickets: []` plus how many are genuinely left
 * (`availableRemaining`) so it can surface a clear 409.
 *
 * Paid tickets claim to `'reserved'` (held while we charge once for the whole
 * order, then finalized to `'sold'` only on a SUCCEEDED charge — see
 * `purchaseTicket`); free tickets claim straight to `'sold'`.
 *
 * @returns `{ tickets }` with exactly `quantity` claimed rows (PURCHASE_INCLUDE
 *   relations) on success, or `{ tickets: [], availableRemaining }` when the
 *   pool could not cover the whole order.
 */
type SaleEvent = { isCancelled: boolean; isPublished: boolean; endDate: Date };

const assertEventOnSale = (event: SaleEvent | undefined): void => {
  if (!event) throw new ApiError('Event not found', 404);
  if (event.isCancelled) {
    throw new ApiError('This event has been cancelled — tickets are no longer on sale.', 400);
  }
  if (!event.isPublished) {
    throw new ApiError('This event is not published — tickets are not on sale.', 400);
  }
  // Match the public listing: an ongoing multi-day event remains on sale.
  if (event.endDate < new Date()) {
    throw new ApiError('This event has finished — tickets are no longer on sale.', 400);
  }
};

type SaleTier = { saleStartDate: Date; saleEndDate: Date };

// Sale windows are start-inclusive and end-exclusive, in absolute UTC time.
const assertTierOnSale = (tier: SaleTier | undefined): void => {
  if (!tier) throw new ApiError('Ticket type not found', 404);
  const now = new Date();
  if (now < tier.saleStartDate) {
    throw new ApiError('This ticket type is not yet on sale.', 400);
  }
  if (now >= tier.saleEndDate) {
    throw new ApiError('Sales for this ticket type have closed.', 400);
  }
};

const claimAvailableTickets = async (
  ticketTypeId: string,
  eventId: string,
  userId: string,
  quantity: number,
  data: Record<string, unknown>
): Promise<{ tickets: any[]; availableRemaining: number }> => {
  return prisma.$transaction(async (tx) => {
    // Hold a shared row lock through the inventory claim. Unpublish/cancel
    // updates take a conflicting lock: whichever commits first determines
    // whether this purchase may claim inventory. Never hold it over YeboPay.
    const events = await tx.$queryRaw<SaleEvent[]>`
      SELECT "isCancelled", "isPublished", "endDate"
      FROM "Event" WHERE "id" = ${eventId} FOR SHARE
    `;
    assertEventOnSale(events[0]);
    // Tier edits use a conflicting row lock. Re-read after acquiring it so an
    // edit committed since the initial lookup cannot bypass the sale window.
    const tiers = await tx.$queryRaw<SaleTier[]>`
      SELECT "saleStartDate", "saleEndDate"
      FROM "TicketType" WHERE "id" = ${ticketTypeId} AND "eventId" = ${eventId} FOR SHARE
    `;
    assertTierOnSale(tiers[0]);
    const claimedIds: string[] = [];

    while (claimedIds.length < quantity) {
      const candidate = await tx.ticket.findFirst({
        where: { ticketTypeId, status: 'available', userId: null },
        select: { id: true },
      });

      if (!candidate) {
        break; // pool exhausted
      }

      // Conditional claim: only flips the row while it is STILL available and
      // unowned. count === 1 -> we won; count === 0 -> another buyer beat us to
      // this exact row between our find and our write.
      const claim = await tx.ticket.updateMany({
        where: { id: candidate.id, status: 'available', userId: null },
        data: { userId, ...data },
      });

      if (claim.count === 1) {
        claimedIds.push(candidate.id);
      }
      // else lost this row; the next findFirst can never return it again.
    }

    if (claimedIds.length < quantity) {
      // Never partially reserve: give back everything this attempt claimed.
      if (claimedIds.length > 0) {
        await tx.ticket.updateMany({
          where: { id: { in: claimedIds }, userId },
          data: {
            userId: null,
            status: 'available',
            reservedAt: null,
            paymentRef: null,
            paymentStatus: null,
            amountPaid: null,
            purchaseDate: null,
          },
        });
      }
      const availableRemaining = await tx.ticket.count({
        where: { ticketTypeId, status: 'available', userId: null },
      });
      return { tickets: [], availableRemaining };
    }

    // We own every row; no other writer can match the guard now, so this read
    // returns our committed claim with the relations needed for delivery.
    const tickets = await tx.ticket.findMany({
      where: { id: { in: claimedIds } },
      include: PURCHASE_INCLUDE,
    });
    if (data.status === 'sold') await enqueueOrderDelivery(tx, tickets);
    return { tickets, availableRemaining: tickets.length };
  });
};

/**
 * Finalize the rows WE reserved (status 'reserved', owned by `userId`) into
 * sold tickets once ONE payment for the whole order SUCCEEDED, persisting the
 * shared YeboPay charge reference on every row. The guard (`status:
 * 'reserved', userId`) means only the buyer who holds the reservations can
 * finalize them. Returns the sold tickets with relations.
 */
const finalizeReservedTickets = async (
  ticketIds: string[],
  userId: string,
  reservedEventId: string,
  payment: { paymentRef: string; paymentStatus: string; amountPaidPerTicket: number }
) => {
  const settled = await commitSettlement(reservedEventId, {
    id: { in: ticketIds }, status: 'reserved', userId,
  }, {
    purchaseDate: new Date(), paymentRef: payment.paymentRef,
    paymentStatus: payment.paymentStatus, amountPaid: payment.amountPaidPerTicket,
  }, { id: { in: ticketIds } });
  if (settled.cancelled) {
    await refundCancelledSettlement(settled.tickets);
    throw new ApiError('Event cancelled. Payment has been refunded; no ticket was issued.', 409);
  }
  return settled.tickets;
};

/** Serialize the sale decision with Event cancellation, without holding a DB
 * transaction over a gateway call. Cancelled paid holds remain reserved until
 * the existing durable refund helper confirms the money was returned. */
const commitSettlement = async (
  eventId: string,
  where: Prisma.TicketWhereInput,
  data: Prisma.TicketUpdateManyMutationInput,
  lookup: Prisma.TicketWhereInput
) => prisma.$transaction(async (tx) => {
  const events = await tx.$queryRaw<{ isCancelled: boolean }[]>`
    SELECT "isCancelled" FROM "Event" WHERE "id" = ${eventId} FOR SHARE
  `;
  if (!events[0]) throw new ApiError('Event not found during settlement', 500);
  const cancelled = events[0].isCancelled;
  const claimed = await tx.ticket.updateMany({
    where,
    data: { ...data, status: cancelled ? 'reserved' : 'sold',
      reservedAt: cancelled ? new Date() : null },
  });
  const tickets = claimed.count ? await tx.ticket.findMany({ where: lookup, include: PURCHASE_INCLUDE }) : [];
  if (!cancelled && tickets.length) await enqueueOrderDelivery(tx, tickets);
  return { cancelled, tickets, claimed: claimed.count };
});

const refundCancelledSettlement = async (tickets: any[]) => {
  for (const ticket of tickets) {
    const outcome = await refundAndCancelTicket(ticket, 'Event cancelled before payment settled');
    if (outcome.result === 'refund_failed') throw new ApiError(outcome.error!, 502);
  }
};

/** Called inside the issuance transaction: sold tickets and their one durable
 * delivery work item commit together, or neither does. */
const enqueueOrderDelivery = async (tx: Prisma.TransactionClient, tickets: any[]) => {
  const id = tickets[0].paymentRef ? `paid:${tickets[0].paymentRef}` : `free:${crypto.randomUUID()}`;
  await tx.ticketOrderDelivery.upsert({ where: { id }, create: { id }, update: {} });
  await tx.ticket.updateMany({ where: { id: { in: tickets.map(t => t.id) } }, data: { deliveryOrderId: id } });
  tickets.forEach(t => { t.deliveryOrderId = id; });
};

const deliveryView = (row: { status: string; channel: string | null; error: string | null; attemptedAt: Date | null }) => ({
  status: row.status as TicketDeliveryResult['status'], channel: row.channel,
  error: row.error || undefined, attemptedAt: row.attemptedAt,
});

/** A DB compare-and-set owns dispatch across workers and buyer retries.
 * Never reclaim sending automatically: after a crash the provider may have
 * accepted the message. Only an explicit buyer retry accepts that risk. */
export const dispatchOrderDelivery = async (id: string, manual = false, acknowledgeDuplicateRisk = false): Promise<TicketDeliveryResult> => {
  const row = await prisma.ticketOrderDelivery.findUnique({ where: { id } });
  if (!row) throw new ApiError('Delivery record not found', 404);
  if (row.status === 'sent' || row.status === 'suppressed') return deliveryView(row);
  const stale = row.status === 'sending' && row.attemptedAt && Date.now() - row.attemptedAt.getTime() > 120_000;
  if (row.status === 'sending' && !stale) return deliveryView(row);
  if ((row.status === 'unknown' || stale) && (!manual || !acknowledgeDuplicateRisk)) {
    if (manual) throw new ApiError('Delivery is unconfirmed. Confirm that retrying may send a duplicate message.', 409);
    return { ...deliveryView(row), status: 'unknown' };
  }
  if (manual && row.attemptedAt && Date.now() - row.attemptedAt.getTime() < 60_000) {
    throw new ApiError('Please wait one minute before retrying delivery.', 429);
  }
  const attemptId = crypto.randomUUID();
  const claim = await prisma.ticketOrderDelivery.updateMany({
    where: { id, status: row.status, attemptId: row.attemptId,
      ...(!manual ? { nextAttemptAt: { lte: new Date() } } : {}) },
    data: { status: 'sending', attemptId, attemptedAt: new Date(), attempts: { increment: 1 }, error: null },
  });
  if (!claim.count) return deliveryView((await prisma.ticketOrderDelivery.findUniqueOrThrow({ where: { id } })));
  let outcome: TicketDeliveryResult;
  try {
    // Lock Event then Ticket in the same order as cancellation. Re-read tickets
    // under row locks so individual refunds cannot race an admission message.
    outcome = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "TicketOrderDelivery" WHERE "id" = ${id} FOR UPDATE`;
      const owner = await tx.ticketOrderDelivery.findUniqueOrThrow({ where: { id } });
      if (owner.status !== 'sending' || owner.attemptId !== attemptId) return deliveryView(owner);
      const members = await tx.ticket.findMany({ where: { deliveryOrderId: id }, select: { eventId: true } });
      if (!members.length) return { status: 'suppressed', error: 'No tickets remain in this order.' };
      const events = await tx.$queryRaw<{ isCancelled: boolean }[]>`
        SELECT "isCancelled" FROM "Event" WHERE "id" = ${members[0].eventId} FOR SHARE
      `;
      await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "deliveryOrderId" = ${id} ORDER BY "id" FOR UPDATE`;
      const tickets = await tx.ticket.findMany({ where: { deliveryOrderId: id }, include: PURCHASE_INCLUDE });
      const chargeId = tickets[0]?.paymentRef;
      if (chargeId && await tx.ticketRefundLock.findUnique({ where: { chargeId } })) {
        return { status: 'failed', error: 'A refund is in progress or awaiting reconciliation. Delivery will be checked again.' };
      }
      const eligible = tickets.filter(t => t.status === 'sold' && !t.refundedAt && !t.cancelledAt &&
        (t.paymentStatus === 'SUCCEEDED' || t.paymentStatus === 'FREE'));
      if (!events[0]) throw new ApiError('Event missing during order delivery', 500);
      if (events[0].isCancelled || !eligible.length) {
        return { status: 'suppressed', error: 'Order cancelled or refunded. No admission message sent.' };
      }
      return deliverOrderToBuyer(eligible);
    }, { timeout: 60_000 });
  } catch (error) {
    console.error('Order delivery outcome unconfirmed:', id, error);
    outcome = { status: 'unknown', error: 'Delivery could not be confirmed. A message may already have been sent.' };
  }
  const recorded = await prisma.ticketOrderDelivery.updateMany({ where: { id, attemptId, status: 'sending' }, data: {
    status: outcome.status, channel: outcome.channel, error: outcome.error || null,
    sentAt: outcome.status === 'sent' ? new Date() : null,
    nextAttemptAt: new Date(Date.now() + Math.min(60, 2 ** Math.min(row.attempts, 6)) * 60_000),
  } });
  if (!recorded.count) return deliveryView(await prisma.ticketOrderDelivery.findUniqueOrThrow({ where: { id } }));
  return outcome;
};

const deliverSettledOrder = async (tickets: any[]): Promise<TicketDeliveryResult> =>
  dispatchOrderDelivery(tickets[0].deliveryOrderId);

export const retryTicketOrderDelivery = async (ticketId: string, userId: string, acknowledgeDuplicateRisk = false) => {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, include: { event: true } });
  if (!ticket || ticket.userId !== userId) throw new ApiError('Ticket not found', 404);
  if (ticket.status !== 'sold' || ticket.event.isCancelled || ticket.refundedAt || ticket.cancelledAt) {
    throw new ApiError('Delivery is unavailable for this ticket.', 409);
  }
  if (!ticket.deliveryOrderId) throw new ApiError('This ticket has no tracked delivery order.', 409);
  // Reject corrupted/mixed ownership groups rather than leaking another buyer's QR.
  const others = await prisma.ticket.count({ where: { deliveryOrderId: ticket.deliveryOrderId, userId: { not: userId } } });
  if (others) throw new ApiError('Order ownership could not be verified', 409);
  return dispatchOrderDelivery(ticket.deliveryOrderId, true, acknowledgeDuplicateRisk);
};

export const recoverOrderDeliveries = async () => {
  await prisma.ticketOrderDelivery.updateMany({ where: { status: 'sending', attemptedAt: { lt: new Date(Date.now() - 120_000) } },
    data: { status: 'unknown', error: 'Delivery was interrupted. A message may already have been sent.' } });
  const work = await prisma.ticketOrderDelivery.findMany({ where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' }, take: 20 });
  for (const row of work) await dispatchOrderDelivery(row.id);
};

/**
 * Release reservations back to the pool when payment did NOT succeed, so a
 * failed charge never strands inventory. Conditional on each row still being
 * our reservation. Best-effort: a failure here is logged, not thrown, because
 * the caller is already surfacing the payment failure to the buyer.
 */
const releaseReservedTickets = async (ticketIds: string[], userId: string): Promise<void> => {
  try {
    await prisma.ticket.updateMany({
      where: { id: { in: ticketIds }, status: 'reserved', userId },
      data: {
        status: 'available',
        userId: null,
        reservedAt: null,
        // Clear the payment trail so the freed rows are pristine for the next
        // buyer. Safe because a charge that FAILED is terminal — YeboPay will
        // not later settle it (and an unmatched stray webhook is logged loudly).
        paymentRef: null,
        paymentStatus: null,
        amountPaid: null,
      },
    });
  } catch (error) {
    console.error('Failed to release reserved tickets after payment failure:', ticketIds, error);
  }
};

/**
 * Release EVERY reserved row sharing a YeboPay charge ref back to the pool —
 * used by the reclaim sweep, which only has the stale charge ref in hand (not
 * the full set of ticket ids the original purchase reserved). Same guard and
 * best-effort semantics as {@link releaseReservedTickets}.
 */
const releaseReservedTicketsByPaymentRef = async (
  paymentRef: string,
  userId: string
): Promise<void> => {
  try {
    await prisma.ticket.updateMany({
      where: { paymentRef, status: 'reserved', userId, paymentStatus: { not: 'SUCCEEDED' } },
      data: {
        status: 'available',
        userId: null,
        reservedAt: null,
        paymentRef: null,
        paymentStatus: null,
        amountPaid: null,
      },
    });
  } catch (error) {
    console.error('Failed to release reserved ticket group after payment failure:', paymentRef, error);
  }
};

/**
 * Persist a PENDING (async) charge onto the rows WE reserved, KEEPING them
 * reserved. Guarded on `status: 'reserved', userId` so only the holder writes
 * them. Records the SAME `paymentRef` (the YeboPay charge id) on every row so
 * the later `charge.succeeded` webhook — whose payload carries the charge id
 * but no ticket metadata — can reverse-look-up the whole order, plus each
 * row's `amountPaid` (the per-ticket price) and `paymentStatus: 'PENDING'`.
 * The hold (`reservedAt`) is left in place so the reclaim sweep still owns it
 * if the charge never confirms.
 */
const markReservationsPending = async (
  ticketIds: string[],
  userId: string,
  payment: { paymentRef: string; amountPaidPerTicket: number }
) => {
  await prisma.ticket.updateMany({
    where: { id: { in: ticketIds }, status: 'reserved', userId, paymentStatus: { not: 'SUCCEEDED' } },
    data: {
      paymentRef: payment.paymentRef,
      paymentStatus: 'PENDING',
      amountPaid: payment.amountPaidPerTicket,
    },
  });
  return prisma.ticket.findMany({
    where: { id: { in: ticketIds } },
    include: PURCHASE_INCLUDE,
  });
};

/**
 * Shape the response for a held (payment-pending) ORDER. There is NO ticket to
 * deliver yet — no QR — so each entry deliberately omits the QR fields and
 * carries `pending: true` + a clear buyer-facing message. The controller
 * returns 202 Accepted (not 201) so the client knows the seats are held and
 * the tickets will arrive once the ONE payment for the whole order confirms.
 */
const buildPendingOrderResult = (tickets: any[], paymentRef: string) => ({
  pending: true as const,
  paymentRef,
  paymentStatus: 'PENDING' as const,
  tickets: tickets.map((ticket) => ({
    pending: true as const,
    id: ticket.id,
    status: mapTicketStatus('reserved'),
    paymentRef,
    paymentStatus: 'PENDING' as const,
    amountPaid: ticket.amountPaid ?? null,
    uniqueCode: ticket.uniqueCode,
    event: ticket.event ?? null,
    ticketType: ticket.ticketType
      ? { ...ticket.ticketType, type: mapTicketType(ticket.ticketType.type) }
      : null,
    message: ticket.event?.isCancelled
      ? 'Event cancelled — awaiting payment outcome. Any successful payment will be refunded; no ticket will be issued.'
      : 'Payment pending — approve the prompt on your phone. Your ticket will be issued automatically once payment is confirmed.',
  })),
});

// ===========================================================================
// Asynchronous settlement: YeboPay charge webhooks + reservation reclaim
// ===========================================================================

/** Outcome of settling one YeboPay charge event (webhook or reconcile poll). */
export type WebhookChargeOutcome =
  | { result: 'issued'; ticketId: string; delivery: TicketDeliveryResult }
  | { result: 'released'; ticketId: string }
  | { result: 'already_final'; ticketId: string; status: string }
  | { result: 'unmatched' };

/**
 * ALL tickets sharing a given YeboPay charge ref. An order shares ONE charge
 * across every ticket it bought, so this may return several rows — the
 * settlement functions below finalize/release the WHOLE group together.
 */
const findTicketsByPaymentRef = (paymentRef: string) =>
  prisma.ticket.findMany({ where: { paymentRef }, include: PURCHASE_INCLUDE });

/**
 * Settle a SUCCEEDED charge: finalize EVERY reserved row sharing it into sold
 * tickets and deliver ONE order message covering all of them.
 *
 * Idempotent (webhooks may be redelivered, and the reclaim poll can race the
 * webhook): the flip is a guarded `updateMany` requiring `status: 'reserved'`,
 * so rows already sold match 0 rows and cannot enqueue duplicate delivery work. An
 * unmatched charge is logged loudly (money moved with no ticket to attach) — a
 * reconciliation signal, never a silent swallow.
 */
export const settleSucceededCharge = async (chargeId: string): Promise<WebhookChargeOutcome> => {
  const tickets = await findTicketsByPaymentRef(chargeId);
  if (tickets.length === 0) {
    console.error('YeboPay charge.succeeded matched no ticket(s) — needs reconciliation:', chargeId);
    return { result: 'unmatched' };
  }
  if (tickets.some(t => t.event?.isCancelled) &&
      tickets.some(t => t.paymentStatus === 'SUCCEEDED')) {
    await refundCancelledSettlement(tickets.filter(t => t.status !== 'cancelled'));
    return { result: 'already_final', ticketId: tickets[0].id, status: 'cancelled' };
  }
  if (tickets.every((t) => t.status === 'sold')) {
    return { result: 'already_final', ticketId: tickets[0].id, status: 'sold' };
  }
  if (tickets.some((t) => t.status !== 'reserved')) {
    // The hold was reclaimed/cancelled before this arrived (or the group is in
    // a mixed state) — do NOT resurrect a dead row; flag it instead (buyer may
    // have been debited late).
    console.error(
      `YeboPay charge.succeeded for charge ${chargeId} touching ticket(s) not all 'reserved' — needs reconciliation:`,
      tickets.map((t) => ({ id: t.id, status: t.status }))
    );
    return { result: 'already_final', ticketId: tickets[0].id, status: tickets[0].status };
  }

  const settled = await commitSettlement(tickets[0].eventId,
    { paymentRef: chargeId, status: 'reserved' },
    { purchaseDate: new Date(), paymentStatus: 'SUCCEEDED' },
    { paymentRef: chargeId });
  if (settled.claimed === 0) {
    return { result: 'already_final', ticketId: tickets[0].id, status: 'sold' };
  }
  if (settled.cancelled) {
    await refundCancelledSettlement(settled.tickets);
    return { result: 'already_final', ticketId: tickets[0].id, status: 'cancelled' };
  }
  const sold = settled.tickets;
  const delivery = await deliverSettledOrder(sold);
  return { result: 'issued', ticketId: sold[0].id, delivery };
};

/**
 * Settle a FAILED charge: release EVERY reserved row sharing it back to the
 * pool. Idempotent — rows already released/sold match no reserved guard
 * (no-op). A FAILED arriving for an already-SOLD ticket is a contradiction we
 * refuse to act on (we never unwind a delivered ticket); it is logged for a
 * human.
 */
export const settleFailedCharge = async (chargeId: string): Promise<WebhookChargeOutcome> => {
  const tickets = await findTicketsByPaymentRef(chargeId);
  if (tickets.length === 0) return { result: 'unmatched' };
  if (tickets.some((t) => t.status === 'sold' || t.paymentStatus === 'SUCCEEDED')) {
    console.error(
      `YeboPay charge.failed for an already-SOLD ticket in charge ${chargeId} — conflict, needs reconciliation:`,
      tickets.map((t) => t.id)
    );
    return { result: 'already_final', ticketId: tickets[0].id, status: 'sold' };
  }
  if (tickets.some((t) => t.status !== 'reserved')) {
    return { result: 'already_final', ticketId: tickets[0].id, status: tickets[0].status };
  }
  await releaseReservedTicketsByPaymentRef(chargeId, tickets[0].userId!);
  return { result: 'released', ticketId: tickets[0].id };
};

/**
 * Route a VERIFIED YeboPay charge webhook event to its settlement. Unknown /
 * non-charge events are acknowledged no-ops (logged) so YeboPay marks them
 * delivered rather than treating our 'unhandled' as a failure. Signature
 * verification happens in the webhook service BEFORE this is ever called.
 */
export const handleChargeWebhookEvent = async (
  eventType: string,
  charge: { id: string; description?: unknown }
): Promise<WebhookChargeOutcome | { result: 'ignored' }> => {
  // The signed charge DTO echoes description (but does not echo metadata).
  // Bind an accepted charge even if its create response was lost. The attempt
  // reference is written before the network call and cannot match a reused seat.
  if (eventType === 'charge.succeeded' || eventType === 'charge.failed') {
    const key = typeof charge.description === 'string'
      ? charge.description.match(/\[yebotickets:(attempt:[0-9a-f-]{36})\]$/)?.[1]
      : undefined;
    if (key) {
      await prisma.ticket.updateMany({
        where: { paymentRef: key, status: 'reserved', paymentStatus: 'PROCESSING' },
        data: { paymentRef: charge.id },
      });
    }
  }
  switch (eventType) {
    case 'charge.succeeded':
      return settleSucceededCharge(charge.id);
    case 'charge.failed':
      return settleFailedCharge(charge.id);
    default:
      console.warn('Ignoring unhandled YeboPay webhook event type:', eventType);
      return { result: 'ignored' };
  }
};

/** Per-sweep tally returned by reclaimExpiredReservations (observability/tests). */
export interface ReclaimSummary {
  scanned: number;
  finalized: number;
  released: number;
  stillPending: number;
  errors: number;
}

/**
 * Resolve reservations sitting unconfirmed past the TTL — AUTHORITATIVELY, by
 * asking YeboPay the true charge status, never by guessing from the clock. This
 * both reclaims dead holds (so inventory is never stranded) AND reconciles a
 * settlement whose webhook we missed (the skill notes deliveries are
 * fire-and-forget with no retry, so polling is the documented backstop).
 *
 * Per stale reserved row (optionally scoped to one ticket type):
 *   - no paymentRef, not PROCESSING    → abandoned hold; release at HARD expiry.
 *   - YeboPay SUCCEEDED                → finalize → sold + deliver (missed webhook).
 *   - YeboPay FAILED                   → release the hold.
 *   - PENDING (at any age)             → retain the reference; money can still land.
 *
 * Best-effort per row: a YeboPay error on one row is logged and the row left
 * held, never thrown — one bad charge can't wedge the sweep (or a purchase that
 * lazily triggers it).
 */
export const reclaimExpiredReservations = async (
  ticketTypeId?: string
): Promise<ReclaimSummary> => {
  const now = Date.now();
  const ttlCutoff = new Date(now - RESERVATION_TTL_MS);
  const stale = await prisma.ticket.findMany({
    where: {
      status: 'reserved',
      reservedAt: { lt: ttlCutoff },
      ...(ticketTypeId ? { ticketTypeId } : {}),
    },
    include: PURCHASE_INCLUDE,
    take: RECLAIM_BATCH,
  });

  const summary: ReclaimSummary = {
    scanned: stale.length,
    finalized: 0,
    released: 0,
    stillPending: 0,
    errors: 0,
  };

  for (const ticket of stale) {
    try {
      const pastHardExpiry =
        !ticket.reservedAt || now - ticket.reservedAt.getTime() > RESERVATION_HARD_EXPIRY_MS;

      // No charge ref: the hold never reached a charge — nothing to reconcile
      // against YeboPay. Reclaim only once it is genuinely abandoned (hard expiry).
      if (!ticket.paymentRef) {
        if (pastHardExpiry && ticket.paymentStatus !== 'PROCESSING') {
          await releaseReservedTickets([ticket.id], ticket.userId!);
          summary.released++;
        } else {
          summary.stillPending++;
        }
        continue;
      }

      if (ticket.event?.isCancelled && ticket.paymentStatus === 'SUCCEEDED') {
        await settleSucceededCharge(ticket.paymentRef);
        summary.finalized++;
        continue;
      }
      const charge = await getCharge(ticket.paymentRef);
      if (charge.status === 'SUCCEEDED') {
        const outcome = await settleSucceededCharge(ticket.paymentRef);
        if (outcome.result === 'issued' || outcome.result === 'already_final') summary.finalized++;
      } else if (charge.status === 'FAILED') {
        await releaseReservedTicketsByPaymentRef(ticket.paymentRef, ticket.userId!);
        summary.released++;
      } else {
        summary.stillPending++;
      }
    } catch (error) {
      summary.errors++;
      console.error('Reclaim failed for reserved ticket (left held):', ticket.id, error);
    }
  }

  return summary;
};

/** Throw a 400 unless the buyer supplied a usable YeboPay payment instrument. */
const assertPaymentProvided = (payment?: PurchasePaymentInput): PurchasePaymentInput => {
  if (
    !payment ||
    (!payment.paymentMethodId && !payment.providerCode)
  ) {
    throw new ApiError(
      'Payment details are required: provide a saved paymentMethodId or a providerCode (with phone for mobile money).',
      400
    );
  }
  return payment;
};

/** Max tickets a single purchase call may buy in one order (mirrors the validator). */
export const MAX_PURCHASE_QUANTITY = 10;

/**
 * Purchase an ORDER of `quantity` tickets of the same type (default 1) —
 * collecting payment via YeboPay BEFORE issuing, exactly ONCE for the WHOLE
 * order. A buyer approves at most one mobile-money prompt no matter how many
 * tickets they buy, and a partial failure never takes money for tickets it
 * didn't also issue.
 *
 * Flow for a PRICED ticket type (`price > 0`):
 *   1. Atomically RESERVE `quantity` available rows, ALL or NONE (race-safe
 *      batched claim → 'reserved'; see `claimAvailableTickets`). If fewer than
 *      `quantity` are available, nothing is reserved and this throws 409 with
 *      how many are actually left.
 *   2. Charge the buyer ONCE for `quantity * ticketType.price` via YeboPay.
 *   3. Only on `status === 'SUCCEEDED'` finalize every row to 'sold',
 *      persisting the SAME charge ref on all of them (amountPaid per row stays
 *      `ticketType.price`, so existing per-ticket revenue math keeps working),
 *      then generate + deliver ONE order message covering every ticket.
 *   4. On FAILED/PENDING (or a transport error) we RELEASE all the reservations
 *      and throw loudly — NO ticket is issued (no silent free issue;
 *      CLAUDE.md). There is no fourth partial state: every row in the order
 *      ends up sold, still-reserved (pending), or released — together.
 * A FREE ticket type (`price <= 0`) skips the charge and claims straight to
 * 'sold', same all-or-nothing semantics.
 *
 * The buyer app sends a fresh `idempotencyKey` per ORDER (not per ticket), so
 * the one charge for the whole order is retry-safe — replaying the same key
 * returns the same charge rather than double-charging.
 *
 * Delivery: generates a QR per ticket encoding the canonical { eventId,
 * ticketId: uniqueCode } payload the gate scanner parses, and sends ONE
 * WhatsApp/email message covering the whole order (never one send per
 * ticket). A failed delivery does NOT roll back the paid purchase and is NOT
 * swallowed — it is surfaced via `delivery.status: 'failed'` on every ticket;
 * the buyer still has every QR inline in this response.
 *
 * The claim itself is atomic per row (see `claimAvailableTickets`): concurrent
 * buyers can never be allocated the same Ticket row and the pool can never be
 * oversold.
 *
 * @param ticketTypeId Ticket type ID
 * @param userId User ID (also the YeboPay customer reference / yeboid_sub)
 * @param payment How the buyer is paying (required for priced tickets)
 * @param quantity How many tickets to buy in this order (default 1, 1..MAX_PURCHASE_QUANTITY)
 * @returns `{ pending: false, tickets }` (issued, QRs included) or
 *   `{ pending: true, paymentRef, paymentStatus, tickets }` (held)
 */
export const purchaseTicket = async (
  ticketTypeId: string,
  userId: string,
  payment?: PurchasePaymentInput,
  quantity: number = 1
) => {
  try {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
      throw new ApiError(
        `quantity must be a whole number between 1 and ${MAX_PURCHASE_QUANTITY}`,
        400
      );
    }
    const qty = quantity;

    // Reject off-sale events before any reclaim, inventory write or charge.
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: { select: { isCancelled: true, isPublished: true, endDate: true } } },
    });

    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    assertEventOnSale(ticketType.event);
    assertTierOnSale(ticketType);

    const price = ticketType.price;

    // --- Free tickets: no payment, claim straight to sold, all-or-nothing. ---
    if (!price || price <= 0) {
      const { tickets: freeTickets, availableRemaining } = await claimAvailableTickets(
        ticketTypeId,
        ticketType.eventId,
        userId,
        qty,
        {
          status: 'sold',
          purchaseDate: new Date(),
          paymentStatus: 'FREE',
          amountPaid: 0,
        }
      );
      if (freeTickets.length === 0) {
        throw new ApiError(
          `Only ${availableRemaining} ticket(s) left for this ticket type — requested ${qty}.`,
          409
        );
      }
      return finishIssuedOrder(freeTickets);
    }

    // --- Paid tickets: reserve N -> charge ONCE -> finalize / hold / release. -
    const validPayment = assertPaymentProvided(payment);

    // 0. Reclaim any stale holds for this type FIRST so an abandoned async
    //    PENDING charge can't make this type look sold-out. Best-effort: a
    //    YeboPay outage here is logged, never thrown (it must not block a sale).
    await reclaimExpiredReservations(ticketTypeId).catch((error) =>
      console.error('Reservation reclaim sweep failed (continuing):', ticketTypeId, error)
    );

    // 1. Reserve `qty` available rows atomically, all-or-nothing (held, not yet
    //    sold). reservedAt stamps each hold so the reclaim sweep can later
    //    resolve them if the async charge never confirms.
    const attemptRef = `attempt:${crypto.randomUUID()}`;
    const { tickets: reserved, availableRemaining } = await claimAvailableTickets(
      ticketTypeId,
      ticketType.eventId,
      userId,
      qty,
      { status: 'reserved', reservedAt: new Date(), paymentStatus: 'PROCESSING',
        paymentRef: attemptRef, amountPaid: price }
    );
    if (reserved.length === 0) {
      throw new ApiError(
        `Only ${availableRemaining} ticket(s) left for this ticket type — requested ${qty}.`,
        409
      );
    }
    const reservedIds = reserved.map((t) => t.id);

    // 2. Persist an attempt reference BEFORE charging. An HTTP/transport error
    //    cannot prove no charge was accepted; retain the hold for its webhook.
    let charge;
    try {
      charge = await createCharge({
        amount: price * qty,
        currency: TICKET_CURRENCY,
        yeboidSub: userId,
        paymentMethodId: validPayment.paymentMethodId,
        country: validPayment.country || DEFAULT_COUNTRY,
        providerCode: validPayment.providerCode,
        phone: validPayment.phone,
        cardToken: validPayment.cardToken,
        description: `${qty}x ${ticketType.name} ticket — ${reserved[0].event?.title ?? 'event'} [yebotickets:${attemptRef}]`,
        metadata: {
          ticketIds: reservedIds,
          ticketTypeId,
          eventId: reserved[0].eventId,
          userId,
          quantity: qty,
        },
        idempotencyKey: validPayment.idempotencyKey || crypto.randomUUID(),
      });
    } catch (error) {
      console.error('Charge creation outcome unknown; retained reconciliation hold:', attemptRef, error);
      if (error instanceof YeboPayHttpError) {
        throw new ApiError(`Payment could not be processed (YeboPay ${error.status}).`, 502);
      }
      throw error;
    }

    // 3a. PENDING (asynchronous rail — mobile money). The buyer has NOT paid yet
    //     but WILL be debited once they approve the USSD prompt; the money then
    //     settles via a `charge.succeeded` webhook (handled in handleChargeEvent).
    //     We must KEEP every reservation (releasing them would let the seats
    //     resell while the buyer is mid-approval, then their settled payment
    //     would have no ticket — the exact silent failure CLAUDE.md forbids).
    //     Persist the SAME charge ref on all rows so the webhook can find the
    //     whole order, and tell the buyer their tickets will be issued on
    //     confirmation — NOT a hard failure.
    if (charge.status === 'PENDING') {
      const held = await markReservationsPending(reservedIds, userId, {
        paymentRef: charge.id,
        amountPaidPerTicket: price,
      });
      return buildPendingOrderResult(held.length ? held : reserved, charge.id);
    }

    // 3b. Any non-SUCCEEDED, non-PENDING status (FAILED/REFUNDED/…) is a hard
    //     failure: release every hold and surface it loudly — no ticket issued.
    if (charge.status !== 'SUCCEEDED') {
      await releaseReservedTickets(reservedIds, userId);
      const reason = charge.failure_reason ? `: ${charge.failure_reason}` : '';
      throw new ApiError(`Payment ${charge.status.toLowerCase()}${reason}. No ticket was issued.`, 402);
    }

    // 4. Payment confirmed synchronously — finalize every reservation into a
    //    sold ticket and persist the shared charge reference for
    //    reconciliation/refunds.
    const sold = await finalizeReservedTickets(reservedIds, userId, reserved[0].eventId, {
      paymentRef: charge.id,
      paymentStatus: charge.status,
      amountPaidPerTicket: price,
    });
    if (sold.length === 0) {
      throw new ApiError('Failed to finalize the purchased ticket(s)', 500);
    }

    return finishIssuedOrder(sold);
  } catch (error) {
    console.error('Error in purchaseTicket service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to purchase ticket', 500);
  }
};

/**
 * Shared tail of a successful issue: deliver ONE order message over WhatsApp
 * covering every ticket (failures surfaced, not swallowed) and shape the
 * response as `{ pending: false, tickets }`, each carrying its own QR plus the
 * shared delivery outcome.
 */
const finishIssuedOrder = async (tickets: any[]) => {
  const delivery = await deliverSettledOrder(tickets);
  const withQr = await Promise.all(
    tickets.map(async (ticket) => {
      const qr = await withQrFields(ticket);
      return {
        ...qr,
        status: mapTicketStatus(ticket.status),
        ticketType: ticket.ticketType
          ? { ...ticket.ticketType, type: mapTicketType(ticket.ticketType.type) }
          : null,
        delivery,
      };
    })
  );
  return { pending: false as const, tickets: withQr };
};

/**
 * List the YeboPay payment rails the buyer can pick (for the given country),
 * plus any methods this buyer has saved. The buyer app renders this to build
 * the payment picker so we never hardcode a provider enum. Throws loudly (no
 * fallback) if YeboPay is unreachable or the key is unset — the buyer must see
 * that payment options could not be loaded rather than a fake empty list.
 *
 * @param userId Buyer id (used as the YeboPay customer ref for saved methods)
 * @param country ISO country code; defaults to SZ (Eswatini)
 */
export const getPaymentOptions = async (
  userId: string,
  country?: string
): Promise<PaymentOptionsResponse> => {
  try {
    return await listPaymentOptions({
      country: country || DEFAULT_COUNTRY,
      customerYeboidSub: userId,
    });
  } catch (error) {
    console.error('Error in getPaymentOptions service:', error);
    if (error instanceof YeboPayHttpError) {
      throw new ApiError(`Could not load payment options (YeboPay ${error.status}).`, 502);
    }
    throw new ApiError('Could not load payment options', 502);
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
        deliveryOrder: true,
        event: {
          select: {
            id: true,
            isCancelled: true,
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
      tickets.map(async ({ deliveryOrder, ...t }) => ({
        ...(t.status === 'sold' && !t.isCheckedIn && !t.event.isCancelled &&
          (t.paymentStatus === 'SUCCEEDED' || t.paymentStatus === 'FREE')
          ? await withQrFields(t)
          : { ...t, qrCode: null, qrPayload: null }),
        delivery: deliveryOrder ? deliveryView(deliveryOrder) : null,
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
      isCancelled: true,
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
  ticket: { status: string; isCheckedIn: boolean; event?: { isCancelled?: boolean } } | null
): { valid: boolean; message: string } => {
  if (!ticket) {
    return { valid: false, message: 'Invalid ticket code' };
  }
  if (ticket.event?.isCancelled || ticket.status !== 'sold') {
    return { valid: false, message: 'Ticket is not valid for check-in' };
  }
  if (ticket.isCheckedIn) {
    return { valid: false, message: 'Ticket has already been used for check-in' };
  }
  return { valid: true, message: 'Ticket is valid for check-in' };
};

/** Claim admission only while the ticket remains sold and unused. */
const claimTicketAdmission = async (ticketId: string) => {
  const claim = await prisma.ticket.updateMany({
    where: { id: ticketId, isCheckedIn: false, status: 'sold' },
    data: { isCheckedIn: true, checkedInAt: new Date() },
  });
  return claim.count === 1;
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

    if (!await claimTicketAdmission(ticket!.id)) {
      return {
        ticket: { ...ticket, status: mapTicketStatus(ticket!.status) },
        valid: false,
        message: 'Ticket is no longer available for check-in',
      };
    }

    const updatedTicket = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticket!.id },
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

    if (!await claimTicketAdmission(ticket!.id)) {
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

/**
 * List an event's sold tickets for OFFLINE caching by the gate scanner.
 *
 * The scanner pre-syncs this set when an operator opens an event so it can keep
 * validating and checking attendees in when the venue network drops. We return
 * ONLY 'sold' tickets — the exact set that is valid for check-in — so a forged
 * or non-sold code can never be accepted offline (the scanner treats anything
 * absent from this set as "not accepted"). Each row carries `isCheckedIn` so the
 * cache starts in sync with the server and the offline path won't re-admit a
 * ticket that was already used online.
 *
 * Access is scoped exactly like the live check-in endpoints via
 * {@link assertEventAccess}: an organizer may only cache their OWN events, an
 * admin any event. The DTO is the same {@link toCheckInTicketDto} shape the
 * scanner already reads from /check-in-details, so the offline and online paths
 * render identically.
 *
 * @param eventId Event whose ticket set to return
 * @param requester Authenticated organizer/admin
 * @returns Flattened sold-ticket DTOs plus a `syncedAt` server timestamp
 */
export const getEventTicketsForCheckIn = async (
  eventId: string,
  requester: CheckInRequester
): Promise<{ eventId: string; syncedAt: string; count: number; tickets: any[] }> => {
  try {
    await assertEventAccess(eventId, requester);

    const tickets = await prisma.ticket.findMany({
      where: { eventId, status: 'sold', event: { isCancelled: false } },
      include: CHECK_IN_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    const dtos = tickets.map(toCheckInTicketDto);

    return {
      eventId,
      syncedAt: new Date().toISOString(),
      count: dtos.length,
      tickets: dtos,
    };
  } catch (error) {
    console.error('Error in getEventTicketsForCheckIn service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to load event tickets for check-in', 500);
  }
};

// ===========================================================================
// Refunds & event cancellation
// ===========================================================================

/**
 * Ticket joined with the holder + event details needed to refund the charge
 * against YeboPay and notify the holder. Loaded per ticket by the refund flow.
 */
const REFUND_INCLUDE = {
  event: { select: { id: true, title: true, startDate: true, isCancelled: true } },
  ticketType: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, phoneNumber: true } },
} as const;

/**
 * Outcome of putting ONE ticket through the refund/cancel flow. Always returned
 * (never thrown) by the per-ticket worker so a bulk event cancellation can
 * report a row-by-row summary; the single-ticket endpoint inspects it and throws
 * on a hard failure so its caller sees a loud error rather than a false success.
 */
export interface TicketRefundOutcome {
  ticketId: string;
  uniqueCode: string;
  /**
   * - `refunded`        money returned via YeboPay, ticket CANCELLED
   * - `cancelled_free`  free ticket voided, nothing to refund
   * - `already_handled` idempotent no-op (ticket was already cancelled/refunded)
   * - `refund_failed`   YeboPay refund did NOT succeed; ticket left untouched
   * - `pending`         payment in flight; retained for later reconciliation
   */
  result: 'refunded' | 'cancelled_free' | 'already_handled' | 'refund_failed' | 'pending';
  amountRefunded?: number;
  refundRef?: string | null;
  /** Whether the holder was notified (a notify failure does NOT undo a refund). */
  notified: boolean;
  notifyError?: string;
  error?: string;
}

/** Compose the cancellation/refund notice sent to the ticket holder. */
const buildCancellationMessage = (ticket: any, refunded: boolean, amount?: number): string => {
  const eventTitle = ticket.event?.title ?? 'your event';
  const lines = [`❌ Your ticket for ${eventTitle} has been cancelled.`];
  if (refunded) {
    const amt = typeof amount === 'number' ? ` of ${amount.toFixed(2)} ${TICKET_CURRENCY}` : '';
    lines.push(`💸 A refund${amt} has been issued to your original payment method.`);
  }
  lines.push(`🔑 Ticket code: ${ticket.uniqueCode}`);
  return lines.join('\n');
};

/**
 * Notify the holder that their ticket was cancelled/refunded. Best-effort:
 * returns the failure rather than throwing, because by this point the money has
 * ALREADY been returned and we must not roll a successful refund back over a
 * messaging hiccup — but the failure is surfaced (not swallowed) in the outcome.
 */
const notifyHolderOfCancellation = async (
  ticket: any,
  refunded: boolean,
  amount?: number
): Promise<{ notified: boolean; notifyError?: string }> => {
  const phone = ticket.user?.phoneNumber;
  if (!phone) {
    return { notified: false, notifyError: 'Holder has no phone number on file' };
  }
  try {
    await sendTextMessage(phone, buildCancellationMessage(ticket, refunded, amount));
    return { notified: true };
  } catch (error) {
    console.error('Failed to notify holder of cancellation:', ticket.id, error);
    return { notified: false, notifyError: errorMessage(error) };
  }
};

/**
 * Refund (if paid) and CANCEL a single sold ticket — idempotently.
 *
 * Order matters (CLAUDE.md "no silent fallbacks"): for a PAID ticket we call
 * YeboPay FIRST and only flip the row to CANCELLED/REFUNDED once the money is
 * confirmed back. If the refund fails we leave the ticket exactly as it was
 * (still `sold`) and report `refund_failed` — the holder is never shown as
 * refunded without the money moving, and a retry (or re-running the event
 * cancellation) picks the ticket up again.
 *
 * A durable charge-wide claim serializes all tickets sharing a paymentRef.
 * Ambiguous provider outcomes retain the claim for manual reconciliation; the
 * gateway has no refund idempotency support, so retrying could move money twice.
 *
 * FREE tickets (no paymentRef / paymentStatus FREE / amountPaid 0) carry no
 * money, so they are simply voided and the holder notified — no YeboPay call.
 */
const refundAndCancelTicket = async (
  ticket: any,
  reason: string
): Promise<TicketRefundOutcome> => {
  const base = { ticketId: ticket.id, uniqueCode: ticket.uniqueCode };

  // --- Idempotent short-circuit: already cancelled/refunded. ---------------
  if (ticket.status === 'cancelled' || ticket.paymentStatus === 'REFUNDED') {
    return { ...base, result: 'already_handled', notified: false };
  }

  const paid =
    !!ticket.paymentRef &&
    ticket.paymentStatus !== 'FREE' &&
    (ticket.amountPaid ?? 0) > 0;

  // --- Free ticket: nothing to refund, just void + notify. -----------------
  if (!paid) {
    const claimed = await prisma.ticket.updateMany({
      where: { id: ticket.id, status: { not: 'cancelled' } },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        // Clear any pending buyer refund request — it's now handled.
        refundRequestedAt: null,
        refundRequestReason: null,
      },
    });
    if (claimed.count === 0) {
      return { ...base, result: 'already_handled', notified: false };
    }
    const notify = await notifyHolderOfCancellation(ticket, false);
    return {
      ...base,
      result: 'cancelled_free',
      notified: notify.notified,
      notifyError: notify.notifyError,
    };
  }

  const failed = (detail: string): TicketRefundOutcome => ({
    ...base,
    result: 'refund_failed',
    notified: false,
    error: `Refund failed: ${detail}. Ticket left unchanged.`,
  });
  const amount = Number(ticket.amountPaid);
  const cents = (value: number) => Math.round(value * 100);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - cents(amount)) > 0.000001) {
    return failed('invalid stored ticket amount');
  }

  // A unique DB key, not a process-local mutex: protects concurrent workers and
  // different tickets on the same charge, including after a process restart.
  const attemptId = crypto.randomUUID();
  try {
    await prisma.$transaction(async tx => {
      // Serialize refund dispatch admission with delivery. Once this durable
      // refund claim exists, delivery defers until it has been reconciled.
      if (ticket.deliveryOrderId) {
        await tx.$queryRaw`SELECT "id" FROM "TicketOrderDelivery" WHERE "id" = ${ticket.deliveryOrderId} FOR UPDATE`;
      }
      await tx.ticketRefundLock.create({
        data: { chargeId: ticket.paymentRef, ticketId: ticket.id, amount, attemptId, phase: 'PREPARED' },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      return failed('another refund is in progress or requires reconciliation for this charge');
    }
    throw error;
  }

  let dispatched = false;
  let refund: { refundRef: string | null; amount: number };
  try {
    // The caller may have loaded a stale ticket before the previous owner of
    // the charge lock committed. Re-read only AFTER acquiring the lock.
    const current = await prisma.ticket.findUnique({ where: { id: ticket.id } });
    if (current?.status === 'cancelled' || current?.paymentStatus === 'REFUNDED') {
      await prisma.ticketRefundLock.delete({ where: { chargeId: ticket.paymentRef, attemptId } });
      return { ...base, result: 'already_handled', notified: false };
    }
    if (!current || (current.status !== 'sold' &&
        !(current.status === 'reserved' && ticket.event?.isCancelled)) || current.paymentStatus !== 'SUCCEEDED' ||
        current.paymentRef !== ticket.paymentRef || current.amountPaid !== amount) {
      throw new Error('ticket is not a confirmed paid sale');
    }
    const charge = await getCharge(ticket.paymentRef);
    const before = Number(charge.refunded_amount);
    const total = Number(charge.amount);
    if (charge.id !== ticket.paymentRef ||
        !['SUCCEEDED', 'PARTIAL_REFUNDED'].includes(charge.status) ||
        !Number.isFinite(before) || before < 0 || !Number.isFinite(total) ||
        cents(before) + cents(amount) > cents(total)) {
      throw new Error('gateway charge is not refundable for this ticket amount');
    }
    await prisma.ticketRefundLock.update({
      where: { chargeId: ticket.paymentRef, attemptId }, data: { refundedBefore: before },
    });
    const claimed = await prisma.ticketRefundLock.updateMany({
      where: { chargeId: ticket.paymentRef, attemptId, phase: 'PREPARED' },
      data: { phase: 'DISPATCHING' },
    });
    if (claimed.count !== 1) throw new Error('refund attempt was recovered before dispatch');
    dispatched = true;
    const res = await refundCharge({ chargeId: ticket.paymentRef, amount, reason });
    // refunded_amount is CUMULATIVE, not the amount returned for this ticket.
    if (res.charge_id !== ticket.paymentRef || res.processor_status !== 'SUCCEEDED' ||
        !['PARTIAL_REFUNDED', 'REFUNDED'].includes(res.status) ||
        !Number.isFinite(Number(res.refunded_amount)) ||
        cents(Number(res.refunded_amount)) !== cents(before) + cents(amount)) {
      throw new Error('gateway did not confirm the exact refund; reconciliation required');
    }
    refund = { refundRef: res.processor_ref ?? res.charge_id, amount };

    await prisma.ticketRefundLock.update({
      where: { chargeId: ticket.paymentRef, attemptId },
      data: { phase: 'CONFIRMED', confirmedRef: refund.refundRef },
    });

    // Keep the claim if this transaction fails after the provider moved money.
    // Ticket finalization and releasing the claim must commit together.
    await finalizeRefundAttempt(ticket.paymentRef, attemptId, refund.refundRef);
  } catch (error) {
    // These gateway responses reject BEFORE processor dispatch. A 409 is a
    // rejection, never evidence that THIS ticket's refund succeeded.
    const rejected = error instanceof YeboPayHttpError &&
      [400, 401, 403, 404, 409, 501].includes(error.status);
    if (dispatched && rejected) {
      await prisma.ticketRefundLock.update({ where: { chargeId: ticket.paymentRef, attemptId },
        data: { phase: 'REJECTED', detail: errorMessage(error) } });
    }
    if (!dispatched || rejected) {
      await prisma.ticketRefundLock.deleteMany({ where: { chargeId: ticket.paymentRef, attemptId } });
    }
    console.error('YeboPay refund failed for ticket', ticket.id, error);
    return failed(`${errorMessage(error)}${dispatched && !rejected ? '; charge blocked pending reconciliation' : ''}`);
  }

  const notify = await notifyHolderOfCancellation(ticket, true, refund.amount);
  return {
    ...base,
    result: 'refunded',
    amountRefunded: refund.amount,
    refundRef: refund.refundRef,
    notified: notify.notified,
    notifyError: notify.notifyError,
  };
};

/**
 * Refund + cancel a SINGLE ticket.
 *
 * Authorization: only the owning organizer (assertEventAccess on the ticket's
 * event) or an admin. Returns the per-ticket outcome; throws loudly (502) when
 * the YeboPay refund did not succeed so the caller sees the failure rather than
 * a false "refunded". An already-cancelled ticket returns `already_handled`
 * (200) — re-calling is safe and never double-refunds.
 *
 * @param ticketId Ticket database id
 * @param requester Authenticated organizer/admin
 * @param reason Optional human-readable reason recorded on the YeboPay refund
 */
export const refundTicket = async (
  ticketId: string,
  requester: CheckInRequester,
  reason?: string
): Promise<TicketRefundOutcome> => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: REFUND_INCLUDE,
    });
    if (!ticket) {
      throw new ApiError('Ticket not found', 404);
    }

    // Ownership guard — reuse the same check the gate check-in flow uses so an
    // organizer can only refund tickets for their OWN events (admins: any).
    await assertEventAccess(ticket.eventId, requester);

    const outcome = await refundAndCancelTicket(
      ticket,
      reason || `Ticket ${ticket.uniqueCode} refunded by organizer`
    );

    if (outcome.result === 'refund_failed') {
      throw new ApiError(outcome.error || 'Refund failed', 502);
    }
    return outcome;
  } catch (error) {
    console.error('Error in refundTicket service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to refund ticket', 500);
  }
};

// ===========================================================================
// Buyer self-service refund REQUEST (intent only — does not move money)
// ===========================================================================

export interface TicketRefundRequestOutcome {
  ticketId: string;
  uniqueCode: string;
  refundRequestedAt: Date;
  /** Whether the organizer was notified (a notify failure still records the request). */
  organizerNotified: boolean;
  organizerNotifyError?: string;
}

/** Compose the notice sent to the organizer when a buyer requests a refund. */
const buildRefundRequestMessage = (ticket: any, reason?: string): string => {
  const eventTitle = ticket.event?.title ?? 'your event';
  const buyerName = ticket.user?.name ?? 'A buyer';
  const lines = [
    `🔔 ${buyerName} requested a refund for their ticket to ${eventTitle}.`,
    `🔑 Ticket code: ${ticket.uniqueCode}`,
  ];
  if (reason) {
    lines.push(`📝 Reason: ${reason}`);
  }
  lines.push('Review it in your dashboard and issue the refund from there if you approve.');
  return lines.join('\n');
};

/**
 * Buyer self-service: flag intent to refund a SOLD ticket the caller owns.
 *
 * Does NOT move money or touch the ticket's status/payment fields — it only
 * records refundRequestedAt/refundRequestReason and notifies the organizer
 * (best-effort, per {@link notifyHolderOfCancellation}'s pattern: a notify
 * failure does not undo the request). The organizer/admin must still act on it
 * via the existing {@link refundTicket} endpoint, which is the only path that
 * actually refunds.
 *
 * Guards: the ticket must belong to `requester` (403 otherwise — prevents an
 * IDOR requesting a refund on someone else's ticket), be `sold` (400), and its
 * event must not already be cancelled (400). A second request while one is
 * already pending is rejected with 409 — the finalizing write is a guarded
 * updateMany so two concurrent requests for the same ticket can't both "win".
 *
 * @param ticketId Ticket database id
 * @param requester Authenticated buyer (must be the ticket's owner)
 * @param reason Optional buyer-supplied reason, forwarded to the organizer
 */
export const requestTicketRefund = async (
  ticketId: string,
  requester: { id: string },
  reason?: string
): Promise<TicketRefundRequestOutcome> => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      event: {
        select: {
          id: true,
          title: true,
          isCancelled: true,
          organizer: { select: { id: true, name: true, phoneNumber: true } },
        },
      },
      user: { select: { id: true, name: true } },
    },
  });

  if (!ticket) {
    throw new ApiError('Ticket not found', 404);
  }
  if (ticket.userId !== requester.id) {
    throw new ApiError('You do not own this ticket', 403);
  }
  if (ticket.status !== 'sold') {
    throw new ApiError('Only a sold ticket can have a refund requested', 400);
  }
  if (ticket.event?.isCancelled) {
    throw new ApiError('This event has already been cancelled', 400);
  }
  if (ticket.refundRequestedAt) {
    throw new ApiError('A refund request is already pending for this ticket', 409);
  }

  const requestedAt = new Date();
  const claimed = await prisma.ticket.updateMany({
    where: { id: ticketId, refundRequestedAt: null },
    data: { refundRequestedAt: requestedAt, refundRequestReason: reason ?? null },
  });
  if (claimed.count === 0) {
    // A concurrent request for the same ticket won the race.
    throw new ApiError('A refund request is already pending for this ticket', 409);
  }

  let organizerNotified = false;
  let organizerNotifyError: string | undefined;
  const organizerPhone = ticket.event?.organizer?.phoneNumber;
  if (organizerPhone) {
    try {
      await sendTextMessage(organizerPhone, buildRefundRequestMessage(ticket, reason));
      organizerNotified = true;
    } catch (error) {
      console.error('Failed to notify organizer of refund request:', ticketId, error);
      organizerNotifyError = errorMessage(error);
    }
  } else {
    organizerNotifyError = 'Organizer has no phone number on file';
  }

  return {
    ticketId,
    uniqueCode: ticket.uniqueCode,
    refundRequestedAt: requestedAt,
    organizerNotified,
    organizerNotifyError,
  };
};

/**
 * Summary returned by cancelEvent: the event is flagged cancelled and every sold
 * ticket is refunded + voided. Per-ticket outcomes are enumerated so any refund
 * or notify failure is surfaced loudly (CLAUDE.md) rather than hidden behind an
 * overall "success".
 */
export interface EventCancellationSummary {
  eventId: string;
  cancelled: true;
  totalProcessed: number;
  refunded: number;
  cancelledFree: number;
  alreadyHandled: number;
  failed: number;
  notifyFailures: number;
  pending: number;
  outcomes: TicketRefundOutcome[];
}

/**
 * Cancel an EVENT: refund every sold ticket via YeboPay and mark each CANCELLED,
 * notifying each holder.
 *
 * Authorization: only the owning organizer (assertEventAccess) or an admin.
 *
 * Idempotent + retryable: the event is flagged `isCancelled` up front so it
 * stops selling/listing even if some refunds need a retry, and re-running only
 * re-processes tickets that are not yet cancelled (e.g. ones whose refund failed
 * earlier). Failures are NOT swallowed — each failed refund is reported in
 * `outcomes` and counted in `failed`, and those tickets stay `sold` (never a
 * false "refunded") until a successful retry.
 *
 * @param eventId Event database id
 * @param requester Authenticated organizer/admin
 */
export const cancelEvent = async (
  eventId: string,
  requester: CheckInRequester
): Promise<EventCancellationSummary> => {
  try {
    await assertEventAccess(eventId, requester);

    // Flag the event cancelled (idempotent). This is the flag purchaseTicket
    // rejects on and getEvents filters out, so sales + public listing stop here
    // even if some refunds below need a retry.
    const event = await prisma.event.update({
      where: { id: eventId },
      data: { isCancelled: true, cancelledAt: new Date() },
    });

    // Paid sales and settled cancelled holds are refunded. Unsettled holds
    // stay owned and referenced until their authoritative payment result arrives.
    const tickets = await prisma.ticket.findMany({
      where: { eventId, status: { in: ['sold', 'reserved'] } },
      include: REFUND_INCLUDE,
    });

    const reason = `Event "${event.title}" cancelled by organizer`;

    // Process sequentially: keeps refund ordering deterministic for
    // reconciliation and avoids hammering the YeboPay gateway in a burst.
    const outcomes: TicketRefundOutcome[] = [];
    for (const ticket of tickets) {
      if (ticket.status === 'reserved' && ticket.paymentStatus !== 'SUCCEEDED') {
        // Keep ownership and the charge reference, including an in-flight
        // createCharge with a durable attempt reference. Its webhook owns settlement.
        outcomes.push({ ticketId: ticket.id, uniqueCode: ticket.uniqueCode,
          result: 'pending', notified: false });
      } else {
        outcomes.push(await refundAndCancelTicket(ticket, reason));
      }
    }

    const summary: EventCancellationSummary = {
      eventId,
      cancelled: true,
      totalProcessed: outcomes.length,
      refunded: outcomes.filter(o => o.result === 'refunded').length,
      cancelledFree: outcomes.filter(o => o.result === 'cancelled_free').length,
      alreadyHandled: outcomes.filter(o => o.result === 'already_handled').length,
      failed: outcomes.filter(o => o.result === 'refund_failed').length,
      notifyFailures: outcomes.filter(o => o.notifyError).length,
      pending: outcomes.filter(o => o.result === 'pending').length,
      outcomes,
    };

    if (summary.failed > 0) {
      console.error(
        `cancelEvent ${eventId}: ${summary.failed}/${summary.totalProcessed} ticket refunds FAILED`,
        outcomes.filter(o => o.result === 'refund_failed')
      );
    }

    return summary;
  } catch (error) {
    console.error('Error in cancelEvent service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to cancel event', 500);
  }
};


// Claim deletion and ticket accounting commit together. The attempt token fences
// stale owners: a replacement attempt can never be released by this one.
const finalizeRefundAttempt = async (chargeId: string, attemptId: string, refundRef: string | null) => {
  return prisma.$transaction(async tx => {
    const lock = await tx.ticketRefundLock.findUnique({ where: { chargeId } });
    if (!lock || lock.attemptId !== attemptId || lock.phase !== 'CONFIRMED') {
      throw new ApiError('Refund attempt changed; reload recovery status', 409);
    }
    const released = await tx.ticketRefundLock.deleteMany({ where: { chargeId, attemptId, phase: 'CONFIRMED' } });
    if (released.count !== 1) throw new ApiError('Refund recovery already in progress', 409);
    await tx.ticket.update({ where: { id: lock.ticketId }, data: {
      status: 'cancelled', paymentStatus: 'REFUNDED', refundRef,
      refundedAt: new Date(), cancelledAt: new Date(),
      refundRequestedAt: null, refundRequestReason: null,
    } });
  });
};

export const listRefundRecovery = async () => {
  const locks = await prisma.ticketRefundLock.findMany({ orderBy: { createdAt: 'asc' } });
  return locks.map(lock => ({ ...lock,
    recoveryStatus: ['PREPARED', 'REJECTED'].includes(lock.phase) ? 'RETRYABLE_AFTER_RECONCILIATION'
      : lock.phase === 'CONFIRMED' ? 'READY_TO_RECONCILE' : 'REVIEW_REQUIRED',
    action: 'POST /api/tickets/refund-recovery/' + encodeURIComponent(lock.chargeId) + '/reconcile with attemptId',
  }));
};

/** Never dispatch money from recovery. An unchanged cumulative total cannot
 * prove that an in-flight processor request will not settle later. */
export const reconcileRefundAttempt = async (chargeId: string, attemptId: string) => {
  const lock = await prisma.ticketRefundLock.findUnique({ where: { chargeId } });
  if (!lock || lock.attemptId !== attemptId) throw new ApiError('Refund attempt changed; reload recovery status', 409);
  if (['PREPARED', 'REJECTED'].includes(lock.phase)) {
    const released = await prisma.ticketRefundLock.deleteMany({ where: { chargeId, attemptId, phase: lock.phase } });
    if (released.count !== 1) throw new ApiError('Refund dispatch started; reload recovery status', 409);
    return { status: 'RETRYABLE', ticketId: lock.ticketId };
  }
  const charge = await getCharge(chargeId);
  const expected = Number(lock.refundedBefore) + lock.amount;
  if (lock.phase === 'CONFIRMED' && lock.refundedBefore !== null &&
      charge.id === chargeId && charge.currency === TICKET_CURRENCY &&
      ['REFUNDED', 'PARTIAL_REFUNDED'].includes(charge.status) &&
      Number.isFinite(Number(charge.refunded_amount)) &&
      Math.round(Number(charge.refunded_amount) * 100) === Math.round(expected * 100)) {
    await finalizeRefundAttempt(chargeId, attemptId, lock.confirmedRef);
    return { status: 'FINALIZED', ticketId: lock.ticketId };
  }
  const detail = 'Gateway cumulative totals cannot attribute this attempt. Inspect processor refund records for this charge; do not retry money movement. Escalate to payment operations for authoritative attempt evidence.';
  await prisma.ticketRefundLock.updateMany({ where: { chargeId, attemptId }, data: { detail } });
  return { status: 'REVIEW_REQUIRED', ticketId: lock.ticketId, detail, charge };
};
