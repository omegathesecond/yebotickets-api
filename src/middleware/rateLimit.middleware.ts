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
 *
 * `request-otp` is guarded by TWO layered limiters: a precise phone+IP one (5
 * per number) and a coarser IP-only one (20 per network). The phone+IP key
 * alone is bypassable by phone rotation — every distinct number is a fresh
 * bucket worth another 5 sends — so a single host can fan out unlimited SMS and
 * spawn a User row per number (requestOTP auto-creates users). The IP-only cap
 * closes that hole by bounding total issuance per source IP regardless of which
 * number is targeted.
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
 * Build a rate-limit key from the caller's IP alone (IPv6-normalised). This is
 * deliberately phone-agnostic so that rotating the `phoneNumber` in the body
 * cannot mint a fresh budget — every OTP request from a given source IP counts
 * against the same bucket.
 */
const ipOnlyKey = (req: Request): string => ipKeyGenerator(req.ip ?? '');

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
 * Coarse per-network throttle for OTP issuance: max 20 requests per IP per 15
 * minutes, keyed on IP ONLY. Layered in front of `requestOtpLimiter` to stop
 * the phone-rotation bypass — one host can no longer request OTPs for an
 * unlimited number of distinct phone numbers (which would otherwise each get a
 * fresh phone+IP bucket of 5 sends AND auto-create a User row). A legitimate
 * caller on a shared/NAT'd network is very unlikely to need 20 codes in 15
 * minutes, so this leaves real users untouched while capping abuse + cost.
 */
export const requestOtpIpLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 20,
  keyGenerator: ipOnlyKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests from this network. Please wait 15 minutes before trying again.',
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
