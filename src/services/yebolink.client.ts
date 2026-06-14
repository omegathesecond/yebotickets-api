/**
 * Client for YeboLink — the canonical Omevision comms gateway for all
 * SMS / WhatsApp / Email. YeboTickets routes its login OTP and ticket-delivery
 * messages through this instead of talking to a provider (e.g. the WhatsApp
 * Cloud API) directly, per the Omevision platform standard.
 *
 * Auth: workspace API key (`x-api-key: ybk_*`), bound from the
 * YEBOTICKETS__YEBOLINK_API_KEY[_DEV] secret in hiyebo Secret Manager and
 * exposed to the service as the YEBOLINK_API_KEY env var.
 *
 * Fails loud per CLAUDE.md — never silently fall back if YeboLink is down or a
 * send fails. Callers decide how to surface that to the user.
 */

const BASE_URL = process.env.YEBOLINK_BASE_URL ?? 'https://api.yebolink.com';

function getApiKey(): string {
  const key = process.env.YEBOLINK_API_KEY;
  if (!key) throw new Error('YEBOLINK_API_KEY env var is not set');
  return key;
}

export interface YeboLinkMessageResult {
  messageId: string;
  status: string;
}

export interface SendSmsInput {
  /** Recipient phone number in E.164 (e.g. +26878000000). */
  to: string;
  /** Plain-text body of the SMS. */
  text: string;
  /** Optional sender label; defaults to the workspace name. */
  fromName?: string;
}

interface YeboLinkSendResponse {
  success?: boolean;
  data?: { id?: string; status?: string };
  error?: string;
}

/**
 * POST a message to YeboLink's send endpoint and normalise the result.
 * Throws on transport failure or any non-success response, preserving the
 * YeboLink error message so the caller can log/surface it.
 */
async function send(body: Record<string, unknown>): Promise<YeboLinkMessageResult> {
  const res = await fetch(`${BASE_URL}/api/v1/messages/send`, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = (await res.json().catch(() => ({}))) as YeboLinkSendResponse;
  if (!res.ok || !payload.success) {
    throw new Error(
      `YeboLink /messages/send ${res.status}: ${payload.error ?? 'unknown error'}`
    );
  }

  return {
    messageId: payload.data?.id ?? '',
    status: payload.data?.status ?? '',
  };
}

export class YeboLinkClient {
  /**
   * Send a plain SMS. Used for login OTP delivery and ticket-purchase
   * confirmations (the QR itself can't traverse SMS, so callers send the
   * human-readable ticket details + code and surface the QR another way).
   */
  static async sendSMS(input: SendSmsInput): Promise<YeboLinkMessageResult> {
    return send({
      to: input.to,
      channel: 'sms',
      content: {
        text: input.text,
        from_name: input.fromName ?? 'YeboTickets',
      },
    });
  }
}
