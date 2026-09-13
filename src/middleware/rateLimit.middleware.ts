import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { Request } from 'express';
import { AuthenticatedRequest } from '../types/auth';

/**
 * Rate limiters for the unauthenticated OTP auth endpoints.
 *
 * These exist because the OTP flow is the one public, side-effecting surface on
 * the API: `request-otp` spends real money (every call fans out to YeboLink to
 * send an SMS/WhatsApp message) and `verify-otp` is a 6-digit guessing game
 * (~1M combinations). Without throttling an attacker can spam comms cost/abuse
 * and brute-force codes. helmet/cors do NOT rate-limit, so this is additive.
 *
 * The per-OTP failed-attempt lockout in auth.service is the real brute-force
 * defense (it dies after N wrong guesses even across IPs); these limiters are
 * the coarse volume throttle that sits in front of it.
 */

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Build a rate-limit key from the caller's phone number (when present in the
 * body) AND their IP. Keying on phone alone would let one attacker rotate
 * phones from a single host; keying on IP alone would let a NAT'd network share
 * one budget. Combining both throttles the realistic abuse vectors.
 *
 * `ipKeyGenerator` is required by express-rate-limit v8 to normalise IPv6
 * addresses (so a /64 subnet can't trivially sidestep the limit by rotating the
 * host portion of the address).
 */
const phoneAndIpKey = (req: Request): string => {
  const ipPart = ipKeyGenerator(req.ip ?? '');
  const phone = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
  return phone ? `${phone}:${ipPart}` : ipPart;
};

/**
 * Throttle OTP issuance: max 5 requests per phone+IP per 15 minutes.
 * Protects against SMS/WhatsApp spam (cost + abuse of YeboLink).
 */
export const requestOtpLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 5,
  keyGenerator: phoneAndIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests. Please wait 15 minutes before requesting another code.',
  },
});

/**
 * Throttle OTP verification: max 10 attempts per phone+IP per 15 minutes.
 * This is the coarse network-level throttle; the per-OTP attempt counter in
 * auth.service enforces the hard 5-wrong-guesses-then-invalidate lockout.
 */
export const verifyOtpLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 10,
  keyGenerator: phoneAndIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many verification attempts. Please wait 15 minutes and request a new code.',
  },
});

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Build a rate-limit key from the authenticated caller's user id. Mount these
 * limiters AFTER `protect` in the route chain so `req.user` is already
 * populated -- these endpoints all require auth, so keying on IP alone would
 * let one account rotate networks to dodge the cap, and would also
 * incorrectly share one budget across unrelated accounts sitting behind the
 * same NAT/proxy. Falls back to the IP (normalised for IPv6) only in the
 * unreachable case where the limiter runs without `protect` ahead of it.
 */
const userIdKey = (req: Request): string => {
  const userId = (req as AuthenticatedRequest).user?.id;
  return userId ?? ipKeyGenerator(req.ip ?? '');
};

/**
 * Throttle ticket purchases: max 10 requests per authenticated user per 5
 * minutes. `purchaseTicketController` reserves up to 10 seats (all-or-nothing)
 * per call and charges YeboPay once per call, so without a cap a single
 * account (or a handful of cheap throwaway phone-OTP accounts) can script
 * rapid-fire calls to exhaust an event's inventory or rack up failed-charge
 * volume against YeboPay.
 *
 * idempotencyKey interaction: this limiter counts REQUESTS, not distinct
 * orders, so a buyer who retries the SAME order (same idempotencyKey) after a
 * network hiccup still spends one unit of their budget per retry. That's
 * intentional and safe here -- the idempotencyKey is what stops YeboPay from
 * double-charging (see ticket.service.purchaseTicket), not this limiter. A
 * handful of retries (the realistic case for a flaky connection) stays well
 * under the 10-per-5-minutes budget; only sustained hammering (distinct or
 * repeated orders) trips it.
 */
export const purchaseTicketLimiter = rateLimit({
  windowMs: FIVE_MINUTES_MS,
  max: 10,
  keyGenerator: userIdKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many purchase attempts. Please wait a few minutes and try again.',
  },
});

/**
 * Throttle refunds/cancellations: max 10 requests per authenticated organizer
 * (or admin) per 5 minutes, shared across /refund/:ticketId and
 * /events/:eventId/cancel. Protects against a compromised or scripted
 * organizer session mass-refunding an event's sales. Cancelling an event
 * already loops internally over every sold ticket in one call, so this caps
 * request volume, not per-ticket refund volume within a single cancel.
 */
export const refundLimiter = rateLimit({
  windowMs: FIVE_MINUTES_MS,
  max: 10,
  keyGenerator: userIdKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many refund/cancellation attempts. Please wait a few minutes and try again.',
  },
});
