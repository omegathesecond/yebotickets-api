import { privateEvent, controlledProbe, initializeMonitoring } from './sentry';
import * as Sentry from '@sentry/node';

jest.mock('@sentry/node', () => ({
  init: jest.fn(), isInitialized: jest.fn(), captureException: jest.fn(), flush: jest.fn(),
  onUncaughtExceptionIntegration: jest.fn(), onUnhandledRejectionIntegration: jest.fn(),
}));

test('customer data is excluded even from exception text, URLs, tags and future fields', () => {
  const secret = 'PRIVATE_CUSTOMER_CONTENT';
  const result = privateEvent({ type: undefined, event_id: 'a'.repeat(32), environment: 'test',
    message: secret, user: { email: secret }, request: { url: secret, data: secret },
    extra: { secret }, contexts: { arbitrary: { secret } }, breadcrumbs: [{ message: secret }],
    tags: { operation: secret, customer: secret },
    exception: { values: [{ type: secret, value: secret, stacktrace: { frames: [
      { filename: '/app/dist/server.js', lineno: 12, function: secret, vars: { secret } },
      { filename: secret },
    ] } }] },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.tags).toEqual({ service: 'yebotickets-api', operation: 'runtime' });
  expect(result.exception?.values?.[0].stacktrace?.frames).toEqual([{ filename: 'dist/server.js', lineno: 12, in_app: true }]);
});

test('probe fails explicitly when monitoring is absent or delivery times out', async () => {
  jest.mocked(Sentry.isInitialized).mockReturnValue(false);
  await expect(controlledProbe()).rejects.toThrow('not configured');
  jest.mocked(Sentry.isInitialized).mockReturnValue(true);
  jest.mocked(Sentry.flush).mockResolvedValue(false);
  await expect(controlledProbe()).rejects.toThrow('did not complete');
  jest.mocked(Sentry.flush).mockResolvedValue(true);
  jest.mocked(Sentry.captureException).mockReturnValue('a'.repeat(32));
  await expect(controlledProbe()).resolves.toBe('a'.repeat(32));
});

test('production cannot silently start without its monitoring binding', () => {
  const env = process.env.NODE_ENV; const dsn = process.env.SENTRY_DSN;
  try {
    process.env.NODE_ENV = 'production'; delete process.env.SENTRY_DSN;
    expect(initializeMonitoring).toThrow('SENTRY_DSN is required');
  } finally {
    process.env.NODE_ENV = env;
    if (dsn === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = dsn;
  }
});
