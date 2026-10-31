import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn() }));

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import organizerRoutes from '../organizer.routes';
import prisma from '../../config/prisma';
import { errorHandler } from '../../middleware/error.middleware';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const compare = bcrypt.compare as jest.Mock;
const windowMs = 15 * 60 * 1000;
const user = {
  id: 'organizer-1', name: 'Organizer', phoneNumber: '+26878422613',
  companyName: 'Test Events', email: 'organizer@example.com', role: 'organizer', password: 'stored-hash', isVerified: true,
};
const originalAccessSecret = process.env.JWT_SECRET;
const originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.JWT_SECRET = 'login-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'login-test-refresh-secret';
  const app = express();
  // Mirror server.ts: only the last proxy hop is trusted, not arbitrary XFF.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/organizers', organizerRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (originalAccessSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalAccessSecret;
  if (originalRefreshSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
  else process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
});
beforeEach(() => {
  mockReset(db);
  db.user.findFirst.mockResolvedValue(user as any);
  compare.mockResolvedValue(false);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const login = (ip: string, body: object = { email: user.email, password: 'wrong' }) =>
  fetch(`${baseUrl}/api/organizers/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });

it.each([false, true])('bounds wrong passwords with rotating identifiers=%s before more DB/bcrypt work', async rotate => {
  const ip = rotate ? '192.0.2.2' : '192.0.2.1';
  for (let i = 0; i < 10; i++) {
    const res = await login(ip, { email: rotate ? `user${i}@example.com` : user.email, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid credentials' });
  }
  // A malformed payload would return 400 if validation ran before the limiter.
  const blocked = await login(ip, {});
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({ success: false, message: expect.stringContaining('Too many login attempts') });
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(blocked.headers.get('ratelimit-remaining')).toBe('0');
  expect(db.user.findFirst).toHaveBeenCalledTimes(10);
  expect(compare).toHaveBeenCalledTimes(10);
  expect((await login('192.0.2.3' + (rotate ? '1' : '0'))).status).toBe(401);
  expect(db.user.findFirst).toHaveBeenCalledTimes(11);
});

it('renews the budget when its window expires', async () => {
  // Keep network scheduling real while moving Date and the MemoryStore interval.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'performance', 'hrtime'] });
  for (let i = 0; i < 10; i++) expect((await login('192.0.2.4')).status).toBe(401);
  expect((await login('192.0.2.4')).status).toBe(429);
  await jest.advanceTimersByTimeAsync(windowMs + 1);
  expect((await login('192.0.2.4')).status).toBe(401);
  expect(db.user.findFirst).toHaveBeenCalledTimes(11);
  expect(compare).toHaveBeenCalledTimes(11);
});

it.each(['organizer', 'admin'])('preserves email and scanner phone login and tokens for %s', async role => {
  db.user.findFirst.mockResolvedValue({ ...user, role } as any);
  compare.mockResolvedValue(true);
  for (const identifier of [{ email: user.email }, { phoneNumber: user.phoneNumber }]) {
    const res = await login(role === 'admin' ? '192.0.2.6' : '192.0.2.5', { ...identifier, password: 'ValidPassword1' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({ success: true, data: {
      id: user.id, name: user.name, phoneNumber: user.phoneNumber, email: user.email, role,
      organizerProfile: expect.any(Object), token: expect.any(String), refreshToken: expect.any(String),
    } });
    expect(jwt.verify(body.data.token, process.env.JWT_SECRET!)).toMatchObject({ id: user.id, role });
    expect(jwt.verify(body.data.refreshToken, process.env.JWT_REFRESH_SECRET!)).toMatchObject({ id: user.id, role, type: 'refresh' });
    expect(db.user.findFirst).toHaveBeenLastCalledWith({ where: {
      OR: [{ phoneNumber: 'phoneNumber' in identifier ? identifier.phoneNumber : '' }, { email: 'email' in identifier ? identifier.email : '' }],
      role: { in: ['organizer', 'admin'] },
    } });
  }
  expect(compare).toHaveBeenCalledWith('ValidPassword1', user.password);
});

it('keeps the same generic credential error for an unknown account', async () => {
  db.user.findFirst.mockResolvedValue(null);
  const res = await login('192.0.2.7');
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ success: false, error: 'Invalid credentials' });
  expect(compare).not.toHaveBeenCalled();
});

it('counts successful logins toward the same CPU budget', async () => {
  compare.mockResolvedValue(true);
  for (let i = 0; i < 10; i++) expect((await login('192.0.2.8')).status).toBe(200);
  expect((await login('192.0.2.8')).status).toBe(429);
  expect(db.user.findFirst).toHaveBeenCalledTimes(10);
  expect(compare).toHaveBeenCalledTimes(10);
});

it('shares the IP budget across IPv6 host addresses in the same subnet', async () => {
  for (let i = 1; i <= 10; i++) {
    expect((await login(`2001:db8:1234:1::${i}`)).status).toBe(401);
  }
  expect((await login('2001:db8:1234:1::ff')).status).toBe(429);
  expect(db.user.findFirst).toHaveBeenCalledTimes(10);
  expect(compare).toHaveBeenCalledTimes(10);
});
