import crypto from 'crypto';

// Mock the settlement handler so these tests focus purely on signature
// verification + routing, not on ticket DB effects (covered in ticket.service.test).
jest.mock('../ticket.service', () => ({
  handleChargeWebhookEvent: jest.fn(async () => ({ result: 'issued', ticketId: 'ticket-1' })),
}));

import {
  verifyAndParseWebhook,
  processWebhook,
  WebhookVerificationError,
} from '../payment-webhook.service';
import { handleChargeWebhookEvent } from '../ticket.service';

const handleMock = handleChargeWebhookEvent as jest.MockedFunction<typeof handleChargeWebhookEvent>;

const SECRET = 'whsec_test_secret';

/** Sign a body exactly as YeboPay's webhookDelivery.service does. */
const sign = (body: string, t: number, secret = SECRET): string => {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
};

const buildEnvelope = (over: Partial<any> = {}) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'charge.succeeded',
    created: 1700000000,
    data: { id: 'chg_1', status: 'SUCCEEDED', amount: '100.00', currency: 'SZL' },
    ...over,
  });

beforeEach(() => {
  process.env.YEBOPAY_WEBHOOK_SECRET = SECRET;
  handleMock.mockClear();
});

describe('verifyAndParseWebhook', () => {
  it('accepts a correctly-signed payload and returns the parsed event', () => {
    const body = buildEnvelope();
    const t = 1700000000;
    const event = verifyAndParseWebhook(Buffer.from(body), sign(body, t));
    expect(event.type).toBe('charge.succeeded');
    expect(event.data.id).toBe('chg_1');
  });

  it('rejects a missing signature header', () => {
    expect(() => verifyAndParseWebhook(Buffer.from(buildEnvelope()), undefined)).toThrow(
      WebhookVerificationError
    );
  });

  it('rejects a malformed signature header', () => {
    expect(() => verifyAndParseWebhook(Buffer.from(buildEnvelope()), 'garbage')).toThrow(
      WebhookVerificationError
    );
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = buildEnvelope();
    const t = 1700000000;
    const bad = sign(body, t, 'whsec_attacker');
    expect(() => verifyAndParseWebhook(Buffer.from(body), bad)).toThrow(WebhookVerificationError);
  });

  it('rejects when the body is tampered after signing (signature no longer matches)', () => {
    const t = 1700000000;
    const header = sign(buildEnvelope(), t);
    const tampered = buildEnvelope({ data: { id: 'chg_HACKED', status: 'SUCCEEDED' } });
    expect(() => verifyAndParseWebhook(Buffer.from(tampered), header)).toThrow(
      WebhookVerificationError
    );
  });

  it('rejects a valid-signed-but-non-JSON body', () => {
    const body = 'not json';
    const t = 1700000000;
    expect(() => verifyAndParseWebhook(Buffer.from(body), sign(body, t))).toThrow(
      WebhookVerificationError
    );
  });

  it('rejects a signed envelope missing data.id', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded', created: 1, data: {} });
    const t = 1700000000;
    expect(() => verifyAndParseWebhook(Buffer.from(body), sign(body, t))).toThrow(
      WebhookVerificationError
    );
  });

  it('throws if the signing secret is not configured (no silent fallback)', () => {
    delete process.env.YEBOPAY_WEBHOOK_SECRET;
    const body = buildEnvelope();
    expect(() => verifyAndParseWebhook(Buffer.from(body), sign(body, 1700000000))).toThrow(
      /YEBOPAY_WEBHOOK_SECRET/
    );
  });
});

describe('processWebhook', () => {
  it('verifies then routes the event to the settlement handler', async () => {
    const body = buildEnvelope();
    const t = 1700000000;
    const { event, outcome } = await processWebhook(Buffer.from(body), sign(body, t));
    expect(event.data.id).toBe('chg_1');
    expect(handleMock).toHaveBeenCalledWith('charge.succeeded', { id: 'chg_1' });
    expect(outcome).toMatchObject({ result: 'issued' });
  });

  it('does NOT call the handler when verification fails', async () => {
    await expect(
      processWebhook(Buffer.from(buildEnvelope()), 'bad-sig')
    ).rejects.toThrow(WebhookVerificationError);
    expect(handleMock).not.toHaveBeenCalled();
  });
});
