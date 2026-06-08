/**
 * YeboPay webhook verification + handling.
 *
 * YeboPay POSTs charge/checkout/invoice state changes to our registered
 * webhookUrl (POST /api/payments/webhook). The body is HMAC-signed with the
 * merchant's `webhookSecret` so we can trust the event without trusting the
 * source IP. We verify EVERY delivery before acting on it and reject anything
 * unsigned/mis-signed (no silent trust — CLAUDE.md).
 *
 * The signing contract (authoritative, from YeboPay's webhookDelivery.service):
 *   header  YeboPay-Signature: t=<unixSeconds>,v1=<hex>
 *   v1    = HMAC_SHA256(webhookSecret, `${t}.${rawJsonBody}`)
 * We MUST recompute over the RAW request body (not a re-serialized object — key
 * order/whitespace would differ), which is why the route mounts express.raw().
 *
 * Why YeboTickets cares: mobile money (the dominant rail here) is asynchronous —
 * a charge returns PENDING and only settles to SUCCEEDED after the buyer
 * approves a USSD prompt, reported via a `charge.succeeded` webhook. Without
 * this endpoint a buyer could be debited and never receive a ticket.
 *
 * Env: YEBOPAY_WEBHOOK_SECRET — the merchant's webhook signing secret, bound
 * from Secret Manager (YEBOTICKETS__YEBOPAY_WEBHOOK_SECRET[_DEV]). Missing →
 * we throw (no fallback): an unverifiable webhook MUST fail loudly, not be
 * trusted blindly.
 */

import crypto from 'crypto';
import { handleChargeWebhookEvent, type WebhookChargeOutcome } from './ticket.service';

/** Raised on any signature/parse failure — maps to HTTP 401 in the controller. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Read the webhook signing secret, throwing loudly if unset (no fallback). */
const webhookSecret = (): string => {
  const s = process.env['YEBOPAY_WEBHOOK_SECRET'];
  if (!s) {
    throw new Error('YEBOPAY_WEBHOOK_SECRET env is required to verify YeboPay webhooks');
  }
  return s;
};

/** The signed event envelope YeboPay sends (data is the charge/checkout/invoice DTO). */
export interface YeboPayWebhookEvent {
  id: string;
  type: string;
  created: number;
  data: { id: string; status?: string; [k: string]: unknown };
}

/** Parse a `t=<ts>,v1=<hex>` signature header into its parts (null if malformed). */
const parseSignatureHeader = (header: string): { t: string; v1: string } | null => {
  const parts = header.split(',').reduce<Record<string, string>>((acc, kv) => {
    const idx = kv.indexOf('=');
    if (idx > 0) acc[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
    return acc;
  }, {});
  if (!parts['t'] || !parts['v1']) return null;
  return { t: parts['t'], v1: parts['v1'] };
};

/** Constant-time compare of two hex digests (length-safe — no early-exit leak). */
const timingSafeEqualHex = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Verify a YeboPay webhook signature against the RAW body and return the parsed
 * event. Throws on a missing/malformed/mismatched signature so the controller
 * rejects with 401 — an unverified payload is NEVER acted upon.
 *
 * Replay note: we do NOT reject on timestamp age. The signature covers the
 * timestamp (so it can't be forged), and handling is idempotent (a replayed
 * SUCCEEDED finds the ticket already sold → no-op), so a genuine redelivery —
 * including a manual retry from YeboPay's audit table minutes/hours later — must
 * still be honoured rather than dropped.
 */
export const verifyAndParseWebhook = (
  rawBody: Buffer,
  signatureHeader: string | undefined
): YeboPayWebhookEvent => {
  if (!signatureHeader) {
    throw new WebhookVerificationError('Missing YeboPay-Signature header');
  }
  const sig = parseSignatureHeader(signatureHeader);
  if (!sig) {
    throw new WebhookVerificationError('Malformed YeboPay-Signature header');
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret())
    .update(`${sig.t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  if (!timingSafeEqualHex(expected, sig.v1)) {
    throw new WebhookVerificationError('YeboPay webhook signature mismatch');
  }

  let event: YeboPayWebhookEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new WebhookVerificationError('YeboPay webhook body is not valid JSON');
  }
  if (!event || typeof event.type !== 'string' || !event.data || typeof event.data.id !== 'string') {
    throw new WebhookVerificationError('YeboPay webhook envelope missing type/data.id');
  }
  return event;
};

/**
 * Verify then handle a YeboPay webhook delivery end-to-end. Returns the
 * settlement outcome so the controller can 200-ack. Throws
 * WebhookVerificationError on an untrusted payload (→ 401); any handler error
 * propagates (→ 500) so a genuine processing failure is visible, not swallowed —
 * the reclaim poll is the backstop that later reconciles a dropped event.
 */
export const processWebhook = async (
  rawBody: Buffer,
  signatureHeader: string | undefined
): Promise<{ event: YeboPayWebhookEvent; outcome: WebhookChargeOutcome | { result: 'ignored' } }> => {
  const event = verifyAndParseWebhook(rawBody, signatureHeader);
  const outcome = await handleChargeWebhookEvent(event.type, { id: event.data.id });
  return { event, outcome };
};
