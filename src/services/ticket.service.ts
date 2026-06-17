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
 * missed webhook), and leaves a still-PENDING hold alone until the HARD cutoff.
 *
 * TTL (default 15 min) gates when we first poll; the HARD cutoff (default 60
 * min) is the only point at which a charge YeboPay STILL reports PENDING is
 * treated as dead and reclaimed — comfortably beyond any real USSD prompt
 * lifetime, which protects against overselling while preventing inventory from
 * being stranded reserved forever (e.g. against YeboPay's current stub MoMo
 * adapter, which leaves charges PENDING indefinitely).
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
      email: true,
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
  /** The channel that actually delivered (or was attempted last on failure). */
  channel: 'whatsapp' | 'email';
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
 * Compose the HTML body for the ticket-delivery email. Carries the same details
 * as the WhatsApp message plus the QR rendered inline (data URI). Email clients
 * that strip data-URI images still show the ticket code in the text, and the
 * scannable QR is always available inline in the purchase API response.
 */
const buildTicketEmailHtml = (ticket: any, qrDataUrl: string): string => {
  const details = buildTicketMessage(ticket)
    .split('\n')
    .map((line) => (line ? `<p style="margin:4px 0">${line}</p>` : ''))
    .join('');
  return `<div style="font-family:system-ui,Arial,sans-serif;color:#111">${details}` +
    `<div style="margin-top:16px"><img src="${qrDataUrl}" alt="Ticket QR code" width="220" height="220" /></div>` +
    `</div>`;
};

/**
 * Deliver the issued ticket details + code to the buyer over YeboLink (the
 * canonical Omevision comms gateway). Primary channel is WhatsApp; if that
 * fails (or the buyer has no phone on file) we fall back to email when an
 * address is available. The QR is always returned inline in the purchase
 * response, so a messaging failure never strands the buyer.
 *
 * Failures are caught and returned as `status: 'failed'` (never thrown) so the
 * caller can warn the buyer rather than silently pretend delivery worked — a
 * paid purchase is never rolled back over a comms hiccup, but the failure is
 * surfaced, not swallowed.
 */
const deliverTicketToBuyer = async (ticket: any): Promise<TicketDeliveryResult> => {
  const phoneNumber = ticket.user?.phoneNumber;
  const email = ticket.user?.email;
  const text = buildTicketMessage(ticket);
  const errors: string[] = [];

  // Primary channel: WhatsApp via YeboLink.
  if (phoneNumber) {
    try {
      await sendTextMessage(phoneNumber, text);
      return { channel: 'whatsapp', status: 'sent' };
    } catch (error) {
      console.error('Failed to deliver ticket via WhatsApp:', error);
      errors.push(`whatsapp: ${errorMessage(error)}`);
    }
  } else {
    errors.push('whatsapp: buyer has no phone number on file');
  }

  // Fallback channel: email via YeboLink (only if the buyer has one on file).
  if (email) {
    try {
      const qrDataUrl = await generateTicketQrDataUrl(ticket.eventId, ticket.uniqueCode);
      await sendEmailMessage(
        email,
        `Your ticket for ${ticket.event?.title ?? 'your event'}`,
        buildTicketEmailHtml(ticket, qrDataUrl),
        text
      );
      return { channel: 'email', status: 'sent' };
    } catch (error) {
      console.error('Failed to deliver ticket via email:', error);
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
 * Atomically claim exactly one available ticket of a type for a buyer, flipping
 * it to the given target `status` (and applying any extra `data`).
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
 * bounded — each lost race means that row is now taken, so the next `findFirst`
 * (which filters `status: 'available'`) can never return it again; the visible
 * pool strictly shrinks until we claim a row or it is genuinely empty.
 *
 * Paid tickets claim to `'reserved'` (held while we charge, then finalized to
 * `'sold'` only on a SUCCEEDED charge — see `purchaseTicket`); free tickets
 * claim straight to `'sold'`.
 *
 * @returns the claimed ticket (with PURCHASE_INCLUDE relations), or `null` when
 *   no ticket of this type is available.
 */
const claimAvailableTicket = async (
  ticketTypeId: string,
  userId: string,
  data: Record<string, unknown>
) => {
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
      data: { userId, ...data },
    });

    if (claim.count === 0) {
      continue; // lost this row; try the next available candidate
    }

    // We own the row; no other writer can match the guard now, so this read
    // returns our committed claim with the relations needed for delivery.
    return prisma.ticket.findUnique({
      where: { id: candidate.id },
      include: PURCHASE_INCLUDE,
    });
  }
};

/**
 * Finalize a row WE reserved (status 'reserved', owned by `userId`) into a sold
 * ticket once payment SUCCEEDED, persisting the YeboPay charge reference. The
 * guard (`status: 'reserved', userId`) means only the buyer who holds the
 * reservation can finalize it. Returns the sold ticket with relations.
 */
const finalizeReservedTicket = async (
  ticketId: string,
  userId: string,
  payment: { paymentRef: string; paymentStatus: string; amountPaid: number }
) => {
  await prisma.ticket.updateMany({
    where: { id: ticketId, status: 'reserved', userId },
    data: {
      status: 'sold',
      purchaseDate: new Date(),
      reservedAt: null, // hold consumed — drop it out of the reclaim sweep
      paymentRef: payment.paymentRef,
      paymentStatus: payment.paymentStatus,
      amountPaid: payment.amountPaid,
    },
  });

  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: PURCHASE_INCLUDE,
  });
};

/**
 * Release a reservation back to the pool when payment did NOT succeed, so a
 * failed charge never strands inventory. Conditional on the row still being our
 * reservation. Best-effort: a failure here is logged, not thrown, because the
 * caller is already surfacing the payment failure to the buyer.
 */
const releaseReservedTicket = async (ticketId: string, userId: string): Promise<void> => {
  try {
    await prisma.ticket.updateMany({
      where: { id: ticketId, status: 'reserved', userId },
      data: {
        status: 'available',
        userId: null,
        reservedAt: null,
        // Clear the payment trail so the freed row is pristine for the next
        // buyer. Safe because a charge that FAILED is terminal — YeboPay will
        // not later settle it (and an unmatched stray webhook is logged loudly).
        paymentRef: null,
        paymentStatus: null,
        amountPaid: null,
      },
    });
  } catch (error) {
    console.error('Failed to release reserved ticket after payment failure:', ticketId, error);
  }
};

/**
 * Persist a PENDING (async) charge onto the row WE reserved, KEEPING it
 * reserved. Guarded on `status: 'reserved', userId` so only the holder writes
 * it. Records `paymentRef` (the YeboPay charge id) so the later
 * `charge.succeeded` webhook — whose payload carries the charge id but no
 * ticket metadata — can reverse-look-up exactly this row, plus `amountPaid` and
 * `paymentStatus: 'PENDING'`. The hold (`reservedAt`) is left in place so the
 * reclaim sweep still owns it if the charge never confirms.
 */
const markReservationPending = async (
  ticketId: string,
  userId: string,
  payment: { paymentRef: string; amountPaid: number }
) => {
  await prisma.ticket.updateMany({
    where: { id: ticketId, status: 'reserved', userId },
    data: {
      paymentRef: payment.paymentRef,
      paymentStatus: 'PENDING',
      amountPaid: payment.amountPaid,
    },
  });
  return prisma.ticket.findUnique({
    where: { id: ticketId },
    include: PURCHASE_INCLUDE,
  });
};

/**
 * Shape the response for a held (payment-pending) purchase. There is NO ticket
 * to deliver yet — no QR — so this deliberately omits the QR fields and carries
 * `pending: true` + a clear buyer-facing message. The controller returns 202
 * Accepted (not 201) so the client knows the seat is held and the ticket will
 * arrive once payment confirms.
 */
const buildPendingResult = (ticket: any, paymentRef: string) => ({
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
  message:
    'Payment pending — approve the prompt on your phone. Your ticket will be issued automatically once payment is confirmed.',
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

/** The single ticket holding a given YeboPay charge ref (1:1 — one charge per ticket). */
const findTicketByPaymentRef = (paymentRef: string) =>
  prisma.ticket.findFirst({ where: { paymentRef }, include: PURCHASE_INCLUDE });

/**
 * Settle a SUCCEEDED charge: finalize the reserved row holding it into a sold
 * ticket and deliver the QR.
 *
 * Idempotent (webhooks may be redelivered, and the reclaim poll can race the
 * webhook): the flip is a guarded `updateMany` requiring `status: 'reserved'`,
 * so a row already sold matches 0 rows and the QR is delivered EXACTLY once. An
 * unmatched charge is logged loudly (money moved with no ticket to attach) — a
 * reconciliation signal, never a silent swallow.
 */
export const settleSucceededCharge = async (chargeId: string): Promise<WebhookChargeOutcome> => {
  const ticket = await findTicketByPaymentRef(chargeId);
  if (!ticket) {
    console.error('YeboPay charge.succeeded matched no ticket — needs reconciliation:', chargeId);
    return { result: 'unmatched' };
  }
  if (ticket.status === 'sold') {
    return { result: 'already_final', ticketId: ticket.id, status: 'sold' };
  }
  if (ticket.status !== 'reserved') {
    // The hold was reclaimed/cancelled before this arrived — do NOT resurrect a
    // dead row; flag it instead (buyer may have been debited late).
    console.error(
      `YeboPay charge.succeeded for ticket ${ticket.id} in '${ticket.status}' (not reserved) — needs reconciliation:`,
      chargeId
    );
    return { result: 'already_final', ticketId: ticket.id, status: ticket.status };
  }

  const claimed = await prisma.ticket.updateMany({
    where: { id: ticket.id, status: 'reserved', paymentRef: chargeId },
    data: { status: 'sold', purchaseDate: new Date(), reservedAt: null, paymentStatus: 'SUCCEEDED' },
  });
  if (claimed.count === 0) {
    // A concurrent webhook/poll finalized first — exactly-once preserved.
    return { result: 'already_final', ticketId: ticket.id, status: 'sold' };
  }

  const sold = await prisma.ticket.findUnique({ where: { id: ticket.id }, include: PURCHASE_INCLUDE });
  const delivery = await deliverTicketToBuyer(sold);
  return { result: 'issued', ticketId: ticket.id, delivery };
};

/**
 * Settle a FAILED charge: release the reserved row holding it back to the pool.
 * Idempotent — a row already released/sold matches no reserved guard (no-op). A
 * FAILED arriving for an already-SOLD ticket is a contradiction we refuse to act
 * on (we never unwind a delivered ticket); it is logged for a human.
 */
export const settleFailedCharge = async (chargeId: string): Promise<WebhookChargeOutcome> => {
  const ticket = await findTicketByPaymentRef(chargeId);
  if (!ticket) return { result: 'unmatched' };
  if (ticket.status === 'sold') {
    console.error(
      `YeboPay charge.failed for an already-SOLD ticket ${ticket.id} — conflict, needs reconciliation:`,
      chargeId
    );
    return { result: 'already_final', ticketId: ticket.id, status: 'sold' };
  }
  if (ticket.status !== 'reserved') {
    return { result: 'already_final', ticketId: ticket.id, status: ticket.status };
  }
  await releaseReservedTicket(ticket.id, ticket.userId!);
  return { result: 'released', ticketId: ticket.id };
};

/**
 * Route a VERIFIED YeboPay charge webhook event to its settlement. Unknown /
 * non-charge events are acknowledged no-ops (logged) so YeboPay marks them
 * delivered rather than treating our 'unhandled' as a failure. Signature
 * verification happens in the webhook service BEFORE this is ever called.
 */
export const handleChargeWebhookEvent = async (
  eventType: string,
  charge: { id: string }
): Promise<WebhookChargeOutcome | { result: 'ignored' }> => {
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
 *   - no paymentRef                    → never reached a charge; release at HARD expiry.
 *   - YeboPay SUCCEEDED                → finalize → sold + deliver (missed webhook).
 *   - YeboPay FAILED                   → release the hold.
 *   - PENDING & past HARD expiry       → release (charge is dead; USSD long gone).
 *   - PENDING within HARD expiry       → leave held (money may STILL land — never
 *                                        reclaim a live PENDING; that would oversell
 *                                        and orphan a real payment).
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
        if (pastHardExpiry) {
          await releaseReservedTicket(ticket.id, ticket.userId!);
          summary.released++;
        } else {
          summary.stillPending++;
        }
        continue;
      }

      const charge = await getCharge(ticket.paymentRef);
      if (charge.status === 'SUCCEEDED') {
        const outcome = await settleSucceededCharge(ticket.paymentRef);
        if (outcome.result === 'issued' || outcome.result === 'already_final') summary.finalized++;
      } else if (charge.status === 'FAILED') {
        await releaseReservedTicket(ticket.id, ticket.userId!);
        summary.released++;
      } else if (pastHardExpiry) {
        // Still PENDING (or a refund state) long past any real USSD lifetime —
        // treat as dead and reclaim so the seat isn't stranded forever.
        await releaseReservedTicket(ticket.id, ticket.userId!);
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

/**
 * Purchase a ticket — collecting payment via YeboPay BEFORE issuing.
 *
 * Flow for a PRICED ticket (`price > 0`):
 *   1. Atomically RESERVE one available row (race-safe claim → 'reserved').
 *   2. Charge the buyer for `ticketType.price` via YeboPay (`createCharge`).
 *   3. Only on `status === 'SUCCEEDED'` finalize the row to 'sold', persisting
 *      the charge ref/status/amount, then generate + deliver the QR.
 *   4. On FAILED/PENDING (or a transport error) we RELEASE the reservation and
 *      throw loudly — NO ticket is issued (no silent free issue; CLAUDE.md).
 * A FREE ticket (`price <= 0`) skips the charge and claims straight to 'sold'.
 *
 * The buyer app sends a fresh `idempotencyKey` per ticket, so the per-call
 * charge is retry-safe and a multi-ticket order (the app loops this call) is
 * charged once per ticket — never double-charged, never under-charged.
 *
 * Delivery: generates a QR encoding the canonical { eventId, ticketId:
 * uniqueCode } payload the gate scanner parses and sends it (with event detail)
 * over WhatsApp. A failed delivery does NOT roll back the paid purchase and is
 * NOT swallowed — it is surfaced via `delivery.status: 'failed'`; the buyer
 * still has the QR inline in this response.
 *
 * The claim itself is atomic (see `claimAvailableTicket`): concurrent buyers can
 * never be allocated the same Ticket row and the pool can never be oversold.
 *
 * @param ticketTypeId Ticket type ID
 * @param userId User ID (also the YeboPay customer reference / yeboid_sub)
 * @param payment How the buyer is paying (required for priced tickets)
 * @returns Purchased ticket with qrCode, qrPayload, payment fields and delivery status
 */
export const purchaseTicket = async (
  ticketTypeId: string,
  userId: string,
  payment?: PurchasePaymentInput
) => {
  try {
    // Find ticket type (with just the event's cancellation flag — needed to
    // reject sales for a cancelled event before any reserve/charge happens).
    const ticketType = await prisma.ticketType.findUnique({
      where: { id: ticketTypeId },
      include: { event: { select: { isCancelled: true } } },
    });

    if (!ticketType) {
      throw new ApiError('Ticket type not found', 404);
    }

    // A cancelled event is off-sale. Reject BEFORE reserving or charging: a sale
    // here would take the buyer's money via YeboPay for a dead event whose bulk
    // refund has already run and will never revisit this new ticket — a silent
    // failure (CLAUDE.md). cancelEvent flags isCancelled; this is what reads it.
    if (ticketType.event?.isCancelled) {
      throw new ApiError('This event has been cancelled — tickets are no longer on sale.', 400);
    }

    const price = ticketType.price;

    // --- Free tickets: no payment, claim straight to sold. -------------------
    if (!price || price <= 0) {
      const freeTicket = await claimAvailableTicket(ticketTypeId, userId, {
        status: 'sold',
        purchaseDate: new Date(),
        paymentStatus: 'FREE',
        amountPaid: 0,
      });
      if (!freeTicket) {
        throw new ApiError('No tickets available for this ticket type', 400);
      }
      return finishIssuedTicket(freeTicket);
    }

    // --- Paid tickets: reserve -> charge -> finalize / hold / release. -------
    const validPayment = assertPaymentProvided(payment);

    // 0. Reclaim any stale holds for this type FIRST so an abandoned async
    //    PENDING charge can't make this type look sold-out. Best-effort: a
    //    YeboPay outage here is logged, never thrown (it must not block a sale).
    await reclaimExpiredReservations(ticketTypeId).catch((error) =>
      console.error('Reservation reclaim sweep failed (continuing):', ticketTypeId, error)
    );

    // 1. Reserve one available row atomically (held, not yet sold). reservedAt
    //    stamps the hold so the reclaim sweep can later resolve it if the async
    //    charge never confirms.
    const reserved = await claimAvailableTicket(ticketTypeId, userId, {
      status: 'reserved',
      reservedAt: new Date(),
    });
    if (!reserved) {
      throw new ApiError('No tickets available for this ticket type', 400);
    }

    // 2. Charge BEFORE issuing. Any transport error releases the reservation
    //    and surfaces loudly — we never issue a ticket without confirmed money.
    let charge;
    try {
      charge = await createCharge({
        amount: price,
        currency: TICKET_CURRENCY,
        yeboidSub: userId,
        paymentMethodId: validPayment.paymentMethodId,
        country: validPayment.country || DEFAULT_COUNTRY,
        providerCode: validPayment.providerCode,
        phone: validPayment.phone,
        cardToken: validPayment.cardToken,
        description: `${ticketType.name} ticket — ${reserved.event?.title ?? 'event'}`,
        metadata: { ticketId: reserved.id, ticketTypeId, eventId: reserved.eventId, userId },
        idempotencyKey: validPayment.idempotencyKey || crypto.randomUUID(),
      });
    } catch (error) {
      await releaseReservedTicket(reserved.id, userId);
      if (error instanceof YeboPayHttpError) {
        throw new ApiError(`Payment could not be processed (YeboPay ${error.status}).`, 502);
      }
      throw error;
    }

    // 3a. PENDING (asynchronous rail — mobile money). The buyer has NOT paid yet
    //     but WILL be debited once they approve the USSD prompt; the money then
    //     settles via a `charge.succeeded` webhook (handled in handleChargeEvent).
    //     We must KEEP the reservation (releasing it would let the seat resell
    //     while the buyer is mid-approval, then their settled payment would have
    //     no ticket — the exact silent failure CLAUDE.md forbids). Persist the
    //     charge ref so the webhook can find this row, and tell the buyer their
    //     ticket will be issued on confirmation — NOT a hard failure.
    if (charge.status === 'PENDING') {
      const held = await markReservationPending(reserved.id, userId, {
        paymentRef: charge.id,
        amountPaid: Number.parseFloat(charge.amount),
      });
      return buildPendingResult(held ?? reserved, charge.id);
    }

    // 3b. Any non-SUCCEEDED, non-PENDING status (FAILED/REFUNDED/…) is a hard
    //     failure: release the hold and surface it loudly — no ticket issued.
    if (charge.status !== 'SUCCEEDED') {
      await releaseReservedTicket(reserved.id, userId);
      const reason = charge.failure_reason ? `: ${charge.failure_reason}` : '';
      throw new ApiError(`Payment ${charge.status.toLowerCase()}${reason}. No ticket was issued.`, 402);
    }

    // 4. Payment confirmed synchronously — finalize the reservation into a sold
    //    ticket and persist the charge reference for reconciliation/refunds.
    const sold = await finalizeReservedTicket(reserved.id, userId, {
      paymentRef: charge.id,
      paymentStatus: charge.status,
      amountPaid: Number.parseFloat(charge.amount),
    });
    if (!sold) {
      throw new ApiError('Failed to finalize the purchased ticket', 500);
    }

    return finishIssuedTicket(sold);
  } catch (error) {
    console.error('Error in purchaseTicket service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to purchase ticket', 500);
  }
};

/**
 * Shared tail of a successful issue: deliver the QR over WhatsApp (failures
 * surfaced, not swallowed) and shape the response with the QR + delivery status.
 */
const finishIssuedTicket = async (ticket: any) => {
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

// ===========================================================================
// Refunds & event cancellation
// ===========================================================================

/**
 * Ticket joined with the holder + event details needed to refund the charge
 * against YeboPay and notify the holder. Loaded per ticket by the refund flow.
 */
const REFUND_INCLUDE = {
  event: { select: { id: true, title: true, startDate: true } },
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
   */
  result: 'refunded' | 'cancelled_free' | 'already_handled' | 'refund_failed';
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
 * Idempotency: a ticket already `cancelled`/`REFUNDED` is a no-op
 * (`already_handled`); a YeboPay 409 (the charge is no longer in a refundable
 * state — i.e. it was already refunded) is treated as success so a partial
 * earlier run can be completed safely. The final write is a guarded updateMany
 * so two concurrent cancels can never both "win" the same row.
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
      data: { status: 'cancelled', cancelledAt: new Date() },
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

  // --- Paid ticket: refund via YeboPay BEFORE marking cancelled. -----------
  let refund: { refundRef: string | null; amount: number };
  try {
    const res = await refundCharge({ chargeId: ticket.paymentRef, reason });
    refund = {
      refundRef: res.processor_ref ?? res.charge_id,
      amount: Number.parseFloat(res.refunded_amount),
    };
  } catch (error) {
    // A 409 means the charge is no longer refundable; for a charge we previously
    // SUCCEEDED-charged, that is YeboPay telling us it is ALREADY refunded.
    // Treat as an idempotent success so a half-finished run can complete.
    if (error instanceof YeboPayHttpError && error.status === 409) {
      refund = { refundRef: ticket.paymentRef, amount: ticket.amountPaid ?? 0 };
    } else {
      console.error('YeboPay refund failed for ticket', ticket.id, error);
      const detail =
        error instanceof YeboPayHttpError ? `YeboPay ${error.status}` : errorMessage(error);
      return {
        ...base,
        result: 'refund_failed',
        notified: false,
        error: `Refund failed (${detail}). Ticket left unchanged — no refund recorded.`,
      };
    }
  }

  // Money is back — now (and only now) record CANCELLED + REFUNDED. Guarded on
  // status so two concurrent cancels cannot both finalize the same row.
  const claimed = await prisma.ticket.updateMany({
    where: { id: ticket.id, status: { not: 'cancelled' } },
    data: {
      status: 'cancelled',
      paymentStatus: 'REFUNDED',
      refundRef: refund.refundRef,
      refundedAt: new Date(),
      cancelledAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    // A concurrent cancel finalized this row first; the YeboPay 409 guard means
    // the money was only ever returned once.
    return { ...base, result: 'already_handled', notified: false };
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

    // Every ticket that still represents a live sale. Reserved rows are mid
    // purchase (released/finalized by their own flow), so we target 'sold'.
    const tickets = await prisma.ticket.findMany({
      where: { eventId, status: 'sold' },
      include: REFUND_INCLUDE,
    });

    const reason = `Event "${event.title}" cancelled by organizer`;

    // Process sequentially: keeps refund ordering deterministic for
    // reconciliation and avoids hammering the YeboPay gateway in a burst.
    const outcomes: TicketRefundOutcome[] = [];
    for (const ticket of tickets) {
      outcomes.push(await refundAndCancelTicket(ticket, reason));
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
