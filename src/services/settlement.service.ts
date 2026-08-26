import prisma from '../config/prisma';
import { CURRENCY, getPlatformFeePercent, roundMoney } from '../config/platform';

/**
 * Organizer settlement — the SINGLE source of truth for what an organizer is
 * owed and what they may withdraw.
 *
 * Ticket money is charged into the PLATFORM's YeboPay merchant account, so an
 * organizer's balance is a liability the platform owes them, not a wallet they
 * hold. Everything here is derived from real ticket rows on demand; no running
 * balance is stored, so a balance can never drift from the sales that produced
 * it.
 *
 * The chain, in order:
 *
 *   grossSales      Σ what was actually charged for every SOLD ticket
 *   − refundedSales tickets refunded/cancelled — money already returned to the buyer
 *   = eligibleGross ... but only for events that have FINISHED (see below)
 *   − platformFee   eligibleGross × PLATFORM_FEE_PERCENT
 *   = netEarned     what the organizer has actually earned
 *   − paidOut       payouts already settled
 *   − reserved      payouts requested or approved but not yet settled
 *   = available     what they may request right now
 *
 * ELIGIBILITY (the hold-back rule): only tickets for events whose `endDate` has
 * PASSED and which are not cancelled are withdrawable. Until an event has
 * happened it can still be cancelled, which refunds every ticket from the
 * platform's account — if the organizer had already withdrawn that money the
 * platform would be refunding buyers out of its own pocket with no way to claw
 * it back. Sales for future events therefore show as `pendingSales`: visible to
 * the organizer, not yet withdrawable.
 *
 * Refunds are excluded by partitioning the ticket rows HERE rather than by
 * filtering them out in the query, so the exclusion is real application logic
 * that a test can exercise (and break) rather than an invisible SQL predicate.
 */

/** Ticket statuses that represent money that moved: sold (in) or cancelled (refunded out). */
const SETTLEABLE_TICKET_STATUSES = ['sold', 'cancelled'] as const;

/** Payout statuses that have consumed balance but not yet settled. */
export const RESERVED_PAYOUT_STATUSES = ['pending', 'approved'] as const;

/** Money a single ticket actually moved: what YeboPay charged (`amountPaid`)
 *  when present, else the ticket type's list price for legacy rows written
 *  before charges were persisted. Mirrors organizer-event.service.ts's
 *  ticketRevenue so every money figure on the dashboard is derived the same
 *  way — never re-derived from list price when a real charge exists. */
export const ticketRevenue = (t: {
  amountPaid?: number | null;
  ticketType?: { price: number } | null;
}): number => t.amountPaid ?? t.ticketType?.price ?? 0;

export interface EventSettlementLine {
  eventId: string;
  name: string;
  endDate: Date;
  isCancelled: boolean;
  ticketsSold: number;
  /** What was charged for this event's sold tickets. */
  grossSales: number;
  /** What was refunded back to buyers for this event. */
  refundedSales: number;
  /** Whether this event's sales have been released for withdrawal. */
  eligible: boolean;
  /** Human-readable reason when `eligible` is false. */
  holdReason: string | null;
}

export interface OrganizerStatement {
  currency: string;
  feePercent: number;
  /** Every sold ticket across every event — the headline "sales" figure. */
  grossSales: number;
  /** Refunded/cancelled tickets. Informational: already excluded from grossSales. */
  refundedSales: number;
  /** Sold-ticket money still held back because its event has not finished. */
  pendingSales: number;
  /** Sold-ticket money released for settlement (finished, non-cancelled events). */
  eligibleGross: number;
  /** Platform commission on eligibleGross. */
  platformFee: number;
  /** eligibleGross − platformFee: what the organizer has actually earned. */
  netEarned: number;
  /** Already settled to the organizer. */
  paidOut: number;
  /** Requested or approved, awaiting settlement. */
  reserved: number;
  /** netEarned − paidOut − reserved: what may be requested right now. */
  availableBalance: number;
  events: EventSettlementLine[];
}

/** An event's sales are withdrawable once it has ended and was not cancelled. */
const holdReasonFor = (event: { endDate: Date; isCancelled: boolean }, now: Date): string | null => {
  if (event.isCancelled) return 'Event was cancelled';
  if (event.endDate >= now) return 'Event has not finished yet';
  return null;
};

/**
 * Build the organizer's full statement. `now` is injectable so the eligibility
 * boundary is deterministic in tests.
 */
export const getOrganizerStatement = async (
  organizerId: string,
  now: Date = new Date()
): Promise<OrganizerStatement> => {
  const feePercent = getPlatformFeePercent();

  const events = await prisma.event.findMany({
    where: { organizerId },
    select: { id: true, title: true, endDate: true, isCancelled: true },
    orderBy: { endDate: 'desc' },
  });
  const eventIds = events.map((e) => e.id);

  // Pull sold AND cancelled rows together: the split between "earned" and
  // "refunded" is made below in code, not by the query.
  const tickets = eventIds.length
    ? await prisma.ticket.findMany({
        where: { eventId: { in: eventIds }, status: { in: [...SETTLEABLE_TICKET_STATUSES] } },
        select: {
          eventId: true,
          status: true,
          amountPaid: true,
          ticketType: { select: { price: true } },
        },
      })
    : [];

  const soldByEvent = new Map<string, { gross: number; count: number }>();
  const refundedByEvent = new Map<string, number>();

  for (const t of tickets) {
    const amount = ticketRevenue(t);
    if (t.status === 'sold') {
      const bucket = soldByEvent.get(t.eventId) || { gross: 0, count: 0 };
      bucket.gross += amount;
      bucket.count += 1;
      soldByEvent.set(t.eventId, bucket);
    } else {
      // Cancelled/refunded: the buyer got this money back, so it is NOT the
      // organizer's. Tracked only so the statement can show it.
      refundedByEvent.set(t.eventId, (refundedByEvent.get(t.eventId) || 0) + amount);
    }
  }

  const lines: EventSettlementLine[] = events.map((event) => {
    const sold = soldByEvent.get(event.id) || { gross: 0, count: 0 };
    const holdReason = holdReasonFor(event, now);
    return {
      eventId: event.id,
      name: event.title,
      endDate: event.endDate,
      isCancelled: event.isCancelled,
      ticketsSold: sold.count,
      grossSales: roundMoney(sold.gross),
      refundedSales: roundMoney(refundedByEvent.get(event.id) || 0),
      eligible: holdReason === null,
      holdReason,
    };
  });

  const grossSales = lines.reduce((sum, l) => sum + l.grossSales, 0);
  const refundedSales = lines.reduce((sum, l) => sum + l.refundedSales, 0);
  const eligibleGross = lines.filter((l) => l.eligible).reduce((sum, l) => sum + l.grossSales, 0);
  const pendingSales = grossSales - eligibleGross;

  const platformFee = roundMoney((eligibleGross * feePercent) / 100);
  const netEarned = roundMoney(eligibleGross - platformFee);

  const [paidAgg, reservedAgg] = await Promise.all([
    prisma.payoutRequest.aggregate({
      where: { organizerId, status: 'paid' },
      _sum: { amount: true },
    }),
    prisma.payoutRequest.aggregate({
      where: { organizerId, status: { in: [...RESERVED_PAYOUT_STATUSES] } },
      _sum: { amount: true },
    }),
  ]);

  const paidOut = roundMoney(paidAgg._sum?.amount || 0);
  const reserved = roundMoney(reservedAgg._sum?.amount || 0);
  const availableBalance = Math.max(0, roundMoney(netEarned - paidOut - reserved));

  return {
    currency: CURRENCY,
    feePercent,
    grossSales: roundMoney(grossSales),
    refundedSales: roundMoney(refundedSales),
    pendingSales: roundMoney(pendingSales),
    eligibleGross: roundMoney(eligibleGross),
    platformFee,
    netEarned,
    paidOut,
    reserved,
    availableBalance,
    events: lines,
  };
};

/**
 * Split a NET payout amount into the gross ticket revenue it consumes and the
 * platform fee taken out of it.
 *
 * The organizer requests against an already-net balance, so for a net amount A
 * at rate p the gross that produced it is A / (1 − p/100). Persisting all three
 * on the payout row freezes the split at request time.
 */
export const splitPayoutFee = (netAmount: number, feePercent: number) => {
  const grossAmount = roundMoney(netAmount / (1 - feePercent / 100));
  return {
    amount: roundMoney(netAmount),
    feePercent,
    feeAmount: roundMoney(grossAmount - netAmount),
    grossAmount,
  };
};
