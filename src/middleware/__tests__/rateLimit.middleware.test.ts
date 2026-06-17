import type { Request } from 'express';
import { requestOtpIpLimiter, requestOtpLimiter } from '../rateLimit.middleware';

/**
 * These tests drive the express-rate-limit middleware directly with mock
 * req/res/next objects (the project has no supertest), asserting the limiter
 * either calls next() (allowed) or short-circuits with a 429 (blocked).
 *
 * NOTE: each limiter keeps a single in-memory store for the whole process and
 * the window is 15 minutes, so there is no reset between test cases — every
 * test MUST use its own distinct source IP(s) to stay isolated.
 */

interface RunResult {
  passed: boolean; // true => next() was called (request allowed through)
  statusCode: number;
  body: any;
}

const makeReq = (ip: string, phoneNumber?: string): Request =>
  ({ ip, body: phoneNumber ? { phoneNumber } : {}, headers: {} } as unknown as Request);

const runLimiter = (limiter: any, req: Request): Promise<RunResult> =>
  new Promise((resolve) => {
    let settled = false;
    const headers: Record<string, unknown> = {};
    const settle = (passed: boolean, body: unknown) => {
      if (settled) return;
      settled = true;
      resolve({ passed, statusCode: res.statusCode, body });
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v; },
      getHeader: (k: string) => headers[k.toLowerCase()],
      removeHeader: (k: string) => { delete headers[k.toLowerCase()]; },
      on: () => res,
      status: (code: number) => { res.statusCode = code; return res; },
      send: (body: unknown) => { settle(false, body); return res; },
      json: (body: unknown) => { settle(false, body); return res; },
      end: () => { settle(false, undefined); return res; },
    };
    const next = () => settle(true, undefined);
    Promise.resolve(limiter(req, res, next)).catch(() => settle(true, undefined));
  });

describe('requestOtpIpLimiter — IP-only OTP request throttle (phone-rotation guard)', () => {
  it('blocks the 21st request from one IP even when the phone number keeps changing', async () => {
    const ip = '203.0.113.10';

    // 20 requests from the SAME IP but each with a DIFFERENT phone number.
    // Under the phone+IP limiter these would all sail through (fresh bucket per
    // number); the IP-only limiter must count them against one shared budget.
    for (let i = 0; i < 20; i++) {
      const result = await runLimiter(requestOtpIpLimiter, makeReq(ip, `+2687800${1000 + i}`));
      expect(result.passed).toBe(true);
    }

    // 21st request — still a brand-new phone number — must be rejected.
    const blocked = await runLimiter(requestOtpIpLimiter, makeReq(ip, '+26878009999'));
    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({ success: false });
    expect(String(blocked.body.message)).toMatch(/network/i);
  });

  it('keeps a separate budget per source IP', async () => {
    const exhaustedIp = '198.51.100.1';
    for (let i = 0; i < 20; i++) {
      await runLimiter(requestOtpIpLimiter, makeReq(exhaustedIp, `+2687811${1000 + i}`));
    }
    const exhausted = await runLimiter(requestOtpIpLimiter, makeReq(exhaustedIp, '+26878119999'));
    expect(exhausted.passed).toBe(false);

    // A different IP is completely unaffected by the first IP's exhaustion.
    const otherIp = await runLimiter(requestOtpIpLimiter, makeReq('198.51.100.2', '+26878110001'));
    expect(otherIp.passed).toBe(true);
  });
});

describe('requestOtpLimiter — precise phone+IP throttle still intact', () => {
  it('blocks the 6th request for the same phone+IP within the window', async () => {
    const ip = '192.0.2.50';
    const phone = '+26878422613';
    for (let i = 0; i < 5; i++) {
      const result = await runLimiter(requestOtpLimiter, makeReq(ip, phone));
      expect(result.passed).toBe(true);
    }
    const blocked = await runLimiter(requestOtpLimiter, makeReq(ip, phone));
    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(429);
  });
});
