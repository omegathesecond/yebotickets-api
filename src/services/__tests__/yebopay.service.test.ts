/**
 * YeboPay client tests.
 *
 * The headline case here is the GATEWAY HOST. `yebopay.service` resolves its
 * base URL once at module load, so these tests re-import the module under
 * `jest.isolateModules` with `process.env` set per case.
 *
 * Why the host gets its own test: the gateway is `api.yebopay.APP`.
 * `api.yebopay.com` is an unrelated third-party site (Apache/PHP) that Omevision
 * does not control. A `.com` default would ship our `x-api-key` and every charge
 * body to a stranger and no purchase would ever settle — a silent, total payment
 * outage that no other test in this repo would catch, because every other suite
 * mocks the client away.
 */

const OK_JSON = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const ORIGINAL_ENV = { ...process.env };

/**
 * Load a fresh copy of the client with `env` applied, plus a stub fetch.
 *
 * The env stays applied for the rest of the test (restored in afterEach): the
 * base URL is captured at module load, but the API key is read lazily on each
 * dispatch — so tearing the env down here would break every key assertion.
 */
const loadClient = (
  env: Record<string, string | undefined>,
  fetchImpl: jest.Mock
): typeof import('../yebopay.service') => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchImpl;

  let mod!: typeof import('../yebopay.service');
  jest.isolateModules(() => {
    mod = require('../yebopay.service');
  });
  return mod;
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const CHARGE = {
  id: 'chg_1',
  status: 'SUCCEEDED',
  amount: '150.00',
  currency: 'SZL',
  payment_instrument_id: null,
  external_ref: null,
  failure_reason: null,
  refunded_amount: '0',
  description: null,
  created_at: '2026-08-06T00:00:00.000Z',
};

describe('yebopay.service — gateway host', () => {
  it('defaults to the REAL gateway https://api.yebopay.app (never the third-party .com)', async () => {
    const fetchMock = jest.fn(async () =>
      OK_JSON({ success: true, data: { country: 'SZ', currency: 'SZL', options: [], savedMethods: [] } })
    );
    const client = loadClient(
      { YEBOPAY_API_KEY: 'ypk_test', YEBOPAY_BASE_URL: undefined },
      fetchMock
    );

    await client.listPaymentOptions({ country: 'SZ' });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toBe('https://api.yebopay.app/v1/payment-options?country=SZ');
    // Explicit: the wrong host must never appear, on any call.
    expect(url).not.toContain('yebopay.com');
  });

  it('honours an explicit YEBOPAY_BASE_URL (so dev talks to the dev gateway, not prod)', async () => {
    const fetchMock = jest.fn(async () =>
      OK_JSON({ success: true, data: { country: 'SZ', currency: 'SZL', options: [], savedMethods: [] } })
    );
    const client = loadClient(
      { YEBOPAY_API_KEY: 'ypk_test', YEBOPAY_BASE_URL: 'https://dev-api.yebopay.app' },
      fetchMock
    );

    await client.listPaymentOptions({ country: 'SZ', customerYeboidSub: 'user_1' });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://dev-api.yebopay.app/v1/payment-options?country=SZ&customer=user_1'
    );
  });
});

describe('yebopay.service — auth + no silent fallbacks', () => {
  it('throws when YEBOPAY_API_KEY is unset instead of calling the gateway anonymously', async () => {
    const fetchMock = jest.fn();
    const client = loadClient({ YEBOPAY_API_KEY: undefined }, fetchMock);

    await expect(client.listPaymentOptions({ country: 'SZ' })).rejects.toThrow(
      /YEBOPAY_API_KEY/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws YeboPayHttpError preserving status + body on a non-2xx (never a fake success)', async () => {
    const fetchMock = jest.fn(async () =>
      OK_JSON({ success: false, error: 'card declined' }, 402)
    );
    const client = loadClient({ YEBOPAY_API_KEY: 'ypk_test' }, fetchMock);

    const err = await client
      .createCharge({
        amount: 150,
        currency: 'SZL',
        yeboidSub: 'user_1',
        country: 'SZ',
        providerCode: 'MTN_MOMO_SZ',
        phone: '+26878422613',
        idempotencyKey: 'idem-1',
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(client.YeboPayHttpError);
    expect(err.status).toBe(402);
    expect(err.body).toEqual({ success: false, error: 'card declined' });
  });

  it('refuses a charge with neither a saved method nor country+providerCode (no gateway call)', async () => {
    const fetchMock = jest.fn();
    const client = loadClient({ YEBOPAY_API_KEY: 'ypk_test' }, fetchMock);

    await expect(
      client.createCharge({
        amount: 150,
        currency: 'SZL',
        yeboidSub: 'user_1',
        idempotencyKey: 'idem-1',
      })
    ).rejects.toThrow(/paymentMethodId OR country\+providerCode/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('yebopay.service — charge request shape', () => {
  it('sends x-api-key + idempotency-key and a snake_case body', async () => {
    const fetchMock = jest.fn(async () => OK_JSON({ success: true, data: CHARGE, replayed: false }));
    const client = loadClient({ YEBOPAY_API_KEY: 'ypk_live_abc' }, fetchMock);

    const charge = await client.createCharge({
      amount: 150,
      currency: 'SZL',
      yeboidSub: 'user_1',
      country: 'SZ',
      providerCode: 'MTN_MOMO_SZ',
      phone: '+26878422613',
      description: 'VIP ticket',
      metadata: { ticketId: 't1' },
      idempotencyKey: 'idem-abc',
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.yebopay.app/v1/charges');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    // YeboPay authenticates on x-api-key, NOT Authorization.
    expect(headers['x-api-key']).toBe('ypk_live_abc');
    // The dedupe key is what stops a retried network call double-charging.
    expect(headers['idempotency-key']).toBe('idem-abc');

    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: 150,
      currency: 'SZL',
      yeboid_sub: 'user_1',
      country: 'SZ',
      provider_code: 'MTN_MOMO_SZ',
      phone: '+26878422613',
      metadata: { ticketId: 't1' },
    });

    // The caller decides on `status` — the client just reports it faithfully.
    expect(charge.status).toBe('SUCCEEDED');
    expect(charge.amount).toBe('150.00');
  });

  it('reports a PENDING (async mobile-money) charge as PENDING, not success', async () => {
    const fetchMock = jest.fn(async () =>
      OK_JSON({ success: true, data: { ...CHARGE, status: 'PENDING' }, replayed: false })
    );
    const client = loadClient({ YEBOPAY_API_KEY: 'ypk_test' }, fetchMock);

    const charge = await client.createCharge({
      amount: 150,
      currency: 'SZL',
      yeboidSub: 'user_1',
      country: 'SZ',
      providerCode: 'MTN_MOMO_SZ',
      phone: '+26878422613',
      idempotencyKey: 'idem-2',
    });

    expect(charge.status).toBe('PENDING');
  });
});
