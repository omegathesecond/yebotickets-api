/**
 * Client for YeboLink — the canonical comms gateway used by every Omevision
 * product to send SMS / WhatsApp / email (api.yebolink.com).
 *
 * Auth: a per-product workspace API key (`x-api-key: ybk_*`), bound from
 * YEBOTICKETS__YEBOLINK_API_KEY[_DEV] in hiyebo Secret Manager.
 *
 * Fails loud per CLAUDE.md — never silently falls back if YeboLink is down or
 * the key is missing. Callers decide whether a failure is fatal (OTP) or should
 * be surfaced-but-not-fatal (ticket delivery after a paid purchase).
 */

const BASE_URL = process.env.YEBOLINK_BASE_URL ?? 'https://api.yebolink.com';

type Channel = 'sms' | 'whatsapp' | 'email';

const getApiKey = (): string => {
  const key = process.env.YEBOLINK_API_KEY;
  if (!key) {
    throw new Error('YEBOLINK_API_KEY env var is not set');
  }
  return key;
};

export interface YeboLinkMessageResult {
  messageId: string;
  status: string;
}

export interface SendSmsInput {
  to: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface SendWhatsAppInput {
  to: string;
  text: string;
  /** Optional PUBLIC media URLs (not buffers) to attach to the WhatsApp message. */
  mediaUrls?: string[];
  metadata?: Record<string, string>;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  metadata?: Record<string, string>;
}

const send = async (
  channel: Channel,
  to: string,
  content: Record<string, unknown>,
  metadata?: Record<string, string>
): Promise<YeboLinkMessageResult> => {
  const res = await fetch(`${BASE_URL}/api/v1/messages/send`, {
    method: 'POST',
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, channel, content, metadata }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: { id?: string; status?: string };
    error?: string;
  };

  if (!res.ok || !body.success) {
    throw new Error(`YeboLink /messages/send ${res.status}: ${body.error ?? 'unknown error'}`);
  }

  return { messageId: body.data?.id ?? '', status: body.data?.status ?? '' };
};

export class YeboLinkClient {
  static sendSMS(input: SendSmsInput): Promise<YeboLinkMessageResult> {
    return send('sms', input.to, { text: input.text }, input.metadata);
  }

  static sendWhatsApp(input: SendWhatsAppInput): Promise<YeboLinkMessageResult> {
    return send(
      'whatsapp',
      input.to,
      { text: input.text, media_urls: input.mediaUrls },
      input.metadata
    );
  }

  static sendEmail(input: SendEmailInput): Promise<YeboLinkMessageResult> {
    return send(
      'email',
      input.to,
      {
        subject: input.subject,
        html: input.html,
        text: input.text,
        from_name: input.fromName ?? 'YeboTickets',
      },
      input.metadata
    );
  }
}
