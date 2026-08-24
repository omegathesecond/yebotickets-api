import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { requestOtpLimiter, verifyOtpLimiter } from '../rateLimit.middleware';

/**
 * The password-reset routes reuse requestOtpLimiter/verifyOtpLimiter verbatim
 * (see auth.routes.ts) rather than a hand-rolled limiter. This confirms the
 * reused limiters actually trip once their shared budget is exhausted, mounted
 * exactly as auth.routes.ts mounts them: limiter -> handler, no validation or
 * DB access in between.
 */
const startLimitedServer = async (limiter: express.RequestHandler) => {
  const app = express();
  app.post('/test', limiter, (_req, res) => res.status(200).json({ success: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

const stopServer = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('password-reset routes reuse the OTP rate limiters', () => {
  it('requestOtpLimiter (mounted on /request-password-reset) trips after its budget (5 per window) is exhausted', async () => {
    const { server, baseUrl } = await startLimitedServer(requestOtpLimiter);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fetch(`${baseUrl}/test`, { method: 'POST' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    } finally {
      await stopServer(server);
    }
  });

  it('verifyOtpLimiter (mounted on /reset-password) trips after its budget (10 per window) is exhausted', async () => {
    const { server, baseUrl } = await startLimitedServer(verifyOtpLimiter);
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
});
