import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// Stub `protect` to attach req.user straight from a test-only header instead
// of verifying a real JWT, while reusing the REAL `authorize` implementation —
// this proves the actual route wiring gates the admin payout endpoints by
// role, not just that the middleware works in isolation.
jest.mock('../../middleware/auth.middleware', () => {
  const actual = jest.requireActual('../../middleware/auth.middleware');
  return {
    ...actual,
    protect: (req: any, _res: any, next: any) => {
      const role = req.headers['x-test-role'];
      if (role) {
        req.user = { id: 'user-1', role, name: 'Test', phoneNumber: '+1', email: null, isVerified: true };
      }
      next();
    },
  };
});

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import ticketRoutes from '../ticket.routes';
import prisma from '../../config/prisma';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tickets', ticketRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  mockReset(prismaMock);
});

describe('refund recovery authorization', () => {
  it.each([undefined, 'user', 'organizer'])('denies list and reconcile for %s', async role => {
    const headers: Record<string,string> = {'content-type':'application/json'};
    if (role) headers['x-test-role'] = role;
    expect((await fetch(`${baseUrl}/tickets/refund-recovery`, {headers})).status).toBe(403);
    expect((await fetch(`${baseUrl}/tickets/refund-recovery/chg_1/reconcile`, {
      method:'POST', headers, body:JSON.stringify({attemptId:'attempt-1'})
    })).status).toBe(403);
    expect(prismaMock.ticketRefundLock.findUnique).not.toHaveBeenCalled();
  });
  it('allows admin list and requires an attempt token for mutation', async () => {
    prismaMock.ticketRefundLock.findMany.mockResolvedValue([]);
    const headers = {'x-test-role':'admin', 'content-type':'application/json'};
    expect((await fetch(`${baseUrl}/tickets/refund-recovery`, {headers})).status).toBe(200);
    expect((await fetch(`${baseUrl}/tickets/refund-recovery/chg_1/reconcile`, {method:'POST', headers, body:'{}'})).status).toBe(400);
  });
});
