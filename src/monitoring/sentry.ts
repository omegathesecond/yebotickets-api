import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

// Rebuild an allowlisted payload: exception text, request data, users,
// breadcrumbs and arbitrary SDK fields must never export customer content.
export function privateEvent(event: ErrorEvent): ErrorEvent {
  const operation = ['http', 'startup', 'health', 'controlled-probe'].includes(String(event.tags?.operation))
    ? String(event.tags!.operation) : 'runtime';
  const frames = event.exception?.values?.slice(-1)[0]?.stacktrace?.frames
    ?.filter(frame => typeof frame.filename === 'string' && /\/(src|dist)\/[A-Za-z0-9_./-]+\.[cm]?[jt]s$/.test(frame.filename))
    .map(frame => ({ filename: frame.filename!.replace(/^.*\/(src|dist)\//, '$1/'),
      lineno: frame.lineno, colno: frame.colno, in_app: true }));
  return {
    type: undefined, event_id: event.event_id, timestamp: event.timestamp, platform: 'node', level: 'error',
    environment: event.environment, release: event.release,
    tags: { service: 'yebotickets-api', operation },
    exception: { values: [{ type: 'YeboTicketsOperationalError',
      value: 'YeboTickets operation failed. Customer content excluded.',
      ...(frames?.length ? { stacktrace: { frames } } : {}) }] },
    fingerprint: ['{{ default }}', 'yebotickets-api', operation],
  };
}

export function initializeMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (process.env.NODE_ENV === 'production') throw new Error('SENTRY_DSN is required in production');
    return;
  }
  Sentry.init({ dsn, environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.K_REVISION || process.env.COMMIT_SHA,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [],
      urlQueryParams: false, graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false,
      stackFrameVariables: false, frameContextLines: 0 },
    defaultIntegrations: false,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
    tracesSampleRate: 0, maxBreadcrumbs: 0, beforeSend: privateEvent });
}

export function captureFailure(error: unknown, operation: 'http' | 'startup' | 'health' | 'controlled-probe') {
  return Sentry.captureException(error, { tags: { operation } });
}

export async function controlledProbe() {
  if (!Sentry.isInitialized()) throw new Error('Sentry is not configured');
  const eventId = captureFailure(new Error('YeboTickets controlled non-sensitive monitoring probe'), 'controlled-probe');
  if (!await Sentry.flush(10000)) throw new Error('Sentry probe delivery did not complete');
  return eventId;
}
