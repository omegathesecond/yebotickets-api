import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { purchaseTicketLimiter, refundLimiter } from '../rateLimit.middleware';

/**
 * purchaseTicketLimiter (mounted on POST /api/tickets/purchase/:ticketTypeId)
 * and refundLimiter (mounted on POST /api/tickets/refund/:ticketId and
 * POST /api/tickets/events/:eventId/cancel) are keyed on req.user.id, so these
 * tests stand in for `protect` by attaching req.user directly before the
 * limiter runs -- exactly how ticket.routes.ts mounts them (protect ->
 * [authorize ->] limiter -> validate -> controller).
 */
const startLimitedServer = async (limiter: express.RequestHandler, userId: string) => {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user: { id: string } }).user = { id: userId };
    next();
  });
  app.post('/test', limiter, (_req, res) => res.status(200).json({ success: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const stopServer = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('purchaseTicketLimiter', () => {
  it('allows 10 requests per user per window, then returns 429', async () => {
    const { server, baseUrl } = await startLimitedServer(purchaseTicketLimiter, 'user-purchase-1');
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${baseUrl}/test`, { method: 'POST' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await stopServer(server);
    }
  });

  it('scopes the budget per user id -- a different user is unaffected by another user exhausting theirs', async () => {
    const { server, baseUrl } = await startLimitedServer(purchaseTicketLimiter, 'user-purchase-2');
    try {
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/test`, { method: 'POST' });
      }
      const blocked = await fetch(`${baseUrl}/test`, { method: 'POST' });
      expect(blocked.status).toBe(429);
    } finally {
      await stopServer(server);
    }

    const { server: otherServer, baseUrl: otherBaseUrl } = await startLimitedServer(
      purchaseTicketLimiter,
      'user-purchase-3'
    );
    try {
      const res = await fetch(`${otherBaseUrl}/test`, { method: 'POST' });
      expect(res.status).toBe(200);
    } finally {
      await stopServer(otherServer);
    }
  });
});

describe('refundLimiter', () => {
  it('allows 10 requests per organizer per window, then returns 429, and resets after the window', async () => {
    const userId = 'organizer-refund-1';
    const { server, baseUrl } = await startLimitedServer(refundLimiter, userId);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await fetch(`${baseUrl}/test`, { method: 'POST' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);

      // Simulate the 5-minute window elapsing (the limiter's keyGenerator is
      // just the user id, so resetKey(userId) clears that client's bucket
      // exactly as the store would once windowMs has passed -- avoids
      // actually waiting 5 real minutes or faking global timers around a
      // live http server/fetch, which would risk destabilizing the test).
      await refundLimiter.resetKey(userId);

      const afterWindow = await fetch(`${baseUrl}/test`, { method: 'POST' });
      expect(afterWindow.status).toBe(200);
    } finally {
      await stopServer(server);
    }
  });
});
