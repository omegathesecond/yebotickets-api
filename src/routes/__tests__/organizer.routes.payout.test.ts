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
import organizerRoutes from '../organizer.routes';
import prisma from '../../config/prisma';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/organizers', organizerRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  mockReset(prismaMock);
});

describe('GET /organizers/admin/payout-requests — admin-only', () => {
  it('rejects an unauthenticated caller (no user attached) with 403', async () => {
    const res = await fetch(`${baseUrl}/organizers/admin/payout-requests`);
    expect(res.status).toBe(403);
  });

  it('rejects a non-admin organizer with 403', async () => {
    const res = await fetch(`${baseUrl}/organizers/admin/payout-requests`, {
      headers: { 'x-test-role': 'organizer' },
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin through with 200', async () => {
    prismaMock.payoutRequest.findMany.mockResolvedValue([] as any);
    const res = await fetch(`${baseUrl}/organizers/admin/payout-requests`, {
      headers: { 'x-test-role': 'admin' },
    });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /organizers/admin/payout-requests/:id — admin-only', () => {
  const body = JSON.stringify({ status: 'paid' });
  const headers = { 'content-type': 'application/json' };

  it('rejects a non-admin organizer with 403', async () => {
    const res = await fetch(`${baseUrl}/organizers/admin/payout-requests/pr-1`, {
      method: 'PATCH',
      headers: { ...headers, 'x-test-role': 'organizer' },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('lets an admin through to the handler (404 for a missing request, not 403)', async () => {
    prismaMock.payoutRequest.findUnique.mockResolvedValue(null as any);
    const res = await fetch(`${baseUrl}/organizers/admin/payout-requests/pr-1`, {
      method: 'PATCH',
      headers: { ...headers, 'x-test-role': 'admin' },
      body,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /organizers/payout-requests — organizer/admin self-service, not admin-only', () => {
  it('allows an organizer through (own history)', async () => {
    prismaMock.payoutRequest.findMany.mockResolvedValue([] as any);
    const res = await fetch(`${baseUrl}/organizers/payout-requests`, {
      headers: { 'x-test-role': 'organizer' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a caller with no recognized role at all', async () => {
    const res = await fetch(`${baseUrl}/organizers/payout-requests`, {
      headers: { 'x-test-role': 'user' },
    });
    expect(res.status).toBe(403);
  });
});
