import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { Request } from 'express';

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
