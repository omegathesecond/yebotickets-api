/**
 * YeboPay client — the canonical Omevision payments gateway (api.yebopay.com).
 *
 * YeboTickets takes money through YeboPay ONLY; it never talks to a card
 * processor / mobile-money provider directly (that's YeboPay's job to abstract).
 * This thin client is modelled on the production reference at
 * companies/yebodash/api/src/integrations/yebopay.ts, trimmed to the two paths
 * the ticket purchase flow needs: discover rails (`GET /v1/payment-options`) and
 * collect money (`POST /v1/charges`).
 *
 * Per CLAUDE.md "no silent fallbacks": a non-2xx response throws
 * YeboPayHttpError and a missing API key throws — the caller (ticket.service)
 * must surface the failure to the buyer and issue NO ticket. We NEVER pretend a
 * charge succeeded.
 *
 * Env:
 *   YEBOPAY_API_KEY  — provisioned per product, per environment (ypk_*). Bound
 *                      from Secret Manager (YEBOTICKETS__YEBOPAY_API_KEY[_DEV]).
 *   YEBOPAY_BASE_URL — defaults to https://api.yebopay.com.
 */

const YEBOPAY_BASE = process.env['YEBOPAY_BASE_URL'] || 'https://api.yebopay.com';

/** Read the API key, throwing loudly if it is not configured (no fallback). */
const apiKey = (): string => {
  const k = process.env['YEBOPAY_API_KEY'];
  if (!k) {
    throw new Error('YEBOPAY_API_KEY env is required to call YeboPay');
  }
  return k;
};

/** Raised on any non-2xx YeboPay response; preserves the gateway error body. */
export class YeboPayHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly path: string
  ) {
    super(`YeboPay ${path} failed: ${status}`);
    this.name = 'YeboPayHttpError';
  }
}

interface DispatchOpts {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  idempotencyKey?: string;
}

/** Build a `?a=b&c=d` string, dropping undefined values; '' if none. */
const buildQuery = (query?: Record<string, string | undefined>): string => {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
};

/**
 * Low-level HTTP dispatch. Sends `x-api-key` (NOT Authorization), JSON bodies,
 * and an `idempotency-key` on money-moving POSTs so a retried network call never
 * double-charges. Throws YeboPayHttpError on !res.ok, preserving the body.
 */
const dispatch = async <T = unknown>(opts: DispatchOpts): Promise<T> => {
  const headers: Record<string, string> = { 'x-api-key': apiKey() };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await fetch(`${YEBOPAY_BASE}${opts.path}${buildQuery(opts.query)}`, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  if (!res.ok) {
    console.error('YeboPay dispatch failed', {
      method: opts.method,
      path: opts.path,
      status: res.status,
      bodyPreview: raw.slice(0, 300),
    });
    throw new YeboPayHttpError(res.status, parsed, opts.path);
  }
  return parsed as T;
};

export type YeboPayFamily =
  | 'MOBILE_MONEY'
  | 'CARD'
  | 'WALLET'
  | 'BANK_TRANSFER'
  | 'CASH';

/** A rail the buyer can pick for a country (from GET /v1/payment-options). */
export interface PaymentOption {
  family: YeboPayFamily;
  providerCode: string;
  displayName: string;
  iconHint: string | null;
  requiresPhone: boolean;
  requiresCard: boolean;
}

/** A customer's previously-vaulted instrument, scoped by their yeboid_sub. */
export interface SavedPaymentMethod {
  id: string;
  family: YeboPayFamily;
  providerCode: string;
  display: string;
  label: string | null;
  isDefault: boolean;
}

export interface PaymentOptionsResponse {
  country: string;
  currency: string;
  options: PaymentOption[];
  savedMethods: SavedPaymentMethod[];
}

/**
 * GET /v1/payment-options — the active rails for a country plus (optionally) the
 * customer's saved methods. The buyer app renders this to build the payment
 * picker so we never hardcode a provider enum (per the YeboPay skill).
 */
export const listPaymentOptions = async (args: {
  country: string;
  customerYeboidSub?: string;
}): Promise<PaymentOptionsResponse> => {
  const resp = await dispatch<{ success: true; data: PaymentOptionsResponse }>({
    method: 'GET',
    path: '/v1/payment-options',
    query: { country: args.country, customer: args.customerYeboidSub },
  });
  return resp.data;
};

export type YeboPayChargeStatus =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIAL_REFUNDED';

export interface CreateChargeArgs {
  /** Amount to collect (decimal). */
  amount: number;
  /** ISO currency, e.g. 'SZL'. */
  currency: string;
  /** Customer reference YeboPay scopes saved methods by (here: the buyer's id). */
  yeboidSub: string;
  /** Either: charge a saved instrument by id … */
  paymentMethodId?: string;
  /** … OR a one-off: country + provider_code + the family's fields below. */
  country?: string;
  providerCode?: string;
  phone?: string;
  cardToken?: string;
  bankAccountRef?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** Dedupe key — same (merchant, key) returns the same charge, never re-charges. */
  idempotencyKey: string;
}

export interface ChargeResult {
  id: string;
  status: YeboPayChargeStatus;
  amount: string; // YeboPay returns Decimal as a string
  currency: string;
  payment_instrument_id: string | null;
  provider_code?: string;
  external_ref: string | null;
  failure_reason: string | null;
  refunded_amount: string;
  description: string | null;
  created_at: string;
}

/**
 * POST /v1/charges — create a charge and return its status synchronously.
 *
 * Requires EITHER a saved `paymentMethodId` OR a one-off `country`+`providerCode`
 * pair (plus the family field: `phone` for mobile money, `cardToken` for card).
 * Returns the gateway's ChargeResult; the caller decides what to do based on
 * `status` (only `SUCCEEDED` means paid). Throws on any non-2xx — never silently.
 */
export const createCharge = async (args: CreateChargeArgs): Promise<ChargeResult> => {
  if (!args.paymentMethodId && !(args.country && args.providerCode)) {
    throw new Error('createCharge requires either paymentMethodId OR country+providerCode');
  }
  const resp = await dispatch<{ success: true; data: ChargeResult; replayed: boolean }>({
    method: 'POST',
    path: '/v1/charges',
    body: {
      amount: args.amount,
      currency: args.currency,
      yeboid_sub: args.yeboidSub,
      payment_method_id: args.paymentMethodId,
      country: args.country,
      provider_code: args.providerCode,
      phone: args.phone,
      card_token: args.cardToken,
      bank_account_ref: args.bankAccountRef,
      description: args.description,
      metadata: args.metadata,
    },
    idempotencyKey: args.idempotencyKey,
  });
  return resp.data;
};

export interface RefundChargeArgs {
  /** YeboPay charge id stored on the ticket as `paymentRef`. */
  chargeId: string;
  /** Amount to refund. Omit for a full refund of the remaining balance. */
  amount?: number;
  /** Human-readable reason, surfaced in YeboPay's records. */
  reason?: string;
}

export interface RefundResult {
  charge_id: string;
  refunded_amount: string; // YeboPay returns Decimal as a string
  status: 'PARTIAL_REFUNDED' | 'REFUNDED';
  processor_ref: string | null;
  processor_status: string;
}

/**
 * POST /v1/refunds — refund a previously-succeeded charge (full or partial).
 *
 * Modelled on the yebodash reference (companies/yebodash/api/src/integrations/
 * yebopay.ts). YeboPay validates that the charge belongs to this merchant and
 * that its status allows refunding (SUCCEEDED or PARTIAL_REFUNDED) — a charge
 * already fully REFUNDED yields a 409 (YeboPayHttpError) which the caller can
 * treat as an idempotent "already refunded". A 501 means the charge was paid via
 * a path with no refund adapter yet; surface that to the organizer so they know
 * to refund the holder manually rather than us pretending it worked.
 *
 * Throws YeboPayHttpError on any non-2xx — never silently. The caller (the
 * refund flow in ticket.service) MUST NOT mark a ticket refunded unless this
 * resolves successfully.
 */
export const refundCharge = async (args: RefundChargeArgs): Promise<RefundResult> => {
  const resp = await dispatch<{ success: true; data: RefundResult }>({
    method: 'POST',
    path: '/v1/refunds',
    body: {
      charge_id: args.chargeId,
      amount: args.amount,
      reason: args.reason,
    },
  });
  return resp.data;
};
