import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import jwt from 'jsonwebtoken';
import prisma from '../../config/prisma';
import routes from '../dashboard.routes';
import { errorHandler } from '../../middleware/error.middleware';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const originalEnv = { ...process.env };
// Execute the registered middleware chain without binding a network socket.
const request = (path: string, requestHeaders: Record<string, string> = {}) =>
  new Promise<{ status: number; body: any }>((resolve, reject) => {
    const route = (routes as any).stack.find((layer: any) => layer.route?.path === `/${path}`).route;
    const req: any = { headers: requestHeaders, query: {} };
    let status = 200;
    const res: any = {
      status: (code: number) => { status = code; return res; },
      json: (body: any) => resolve({ status, body }),
    };
    let index = 0;
    const next = (error?: Error) => {
      if (error) { errorHandler(error, req, res, next); return; }
      const handler = route.stack[index++]?.handle;
      if (!handler) { reject(new Error('Route completed without a response')); return; }
      Promise.resolve(handler(req, res, next)).catch(reject);
    };
    next();
  });
const headers = (admin: boolean) => admin
  ? { authorization: `Bearer ${jwt.sign({ id: 'admin-1' }, process.env.JWT_SECRET!)}` }
  : { 'x-api-key': process.env.DASHBOARD_API_KEY! };

beforeAll(() => {
  process.env.JWT_SECRET = 'dashboard-route-test-secret';
  process.env.DASHBOARD_API_KEY = 'dashboard-test-key';
});
afterAll(() => { process.env = originalEnv; });
beforeEach(() => {
  mockReset(db);
  db.user.findUnique.mockResolvedValue({ id: 'admin-1', role: 'admin' } as any);
  db.event.count.mockResolvedValue(0);
  db.ticket.count.mockResolvedValue(0);
  db.user.count.mockResolvedValue(0);
  db.ticket.findMany.mockResolvedValueOnce([
    { amountPaid: 100, ticketType: { price: 999 } },
    { amountPaid: 0, ticketType: { price: 999 } },
  ] as any).mockResolvedValueOnce([{ amountPaid: 200, ticketType: { price: 999 } }] as any);
});

it.each([false, true])('returns recorded revenue through real authentication (admin=%s)', async admin => {
  const response = await request(`${admin ? 'admin/' : ''}metrics`, headers(admin));
  expect(response.status).toBe(200);
  expect(response.body.data.revenue).toEqual({ value: 100, trend: 'down', changePercent: -50, currency: 'KES' });
});

it.each([false, true])('forwards database errors to the error channel (admin=%s)', async admin => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    db.event.count.mockRejectedValueOnce(new Error('database unavailable'));
    const response = await request(`${admin ? 'admin/' : ''}metrics`, headers(admin));
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ success: false, error: 'database unavailable' });
  } finally { log.mockRestore(); }
});

it.each(['metrics', 'admin/metrics'])('rejects unauthenticated access to %s', async path => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await request(path)).status).toBe(401);
    expect(db.event.count).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it('rejects an organizer JWT on the admin route', async () => {
  db.user.findUnique.mockResolvedValue({ id: 'organizer-1', role: 'organizer' } as any);
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await request('admin/metrics', headers(true));
    expect(response.status).toBe(403);
    expect(db.event.count).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});
