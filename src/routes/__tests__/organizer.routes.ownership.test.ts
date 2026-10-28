import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../../services/comms.service', () => ({ sendOTP: jest.fn(), sendTextMessage: jest.fn() }));
import prisma from '../../config/prisma';
import organizerRoutes from '../organizer.routes';
import authRoutes from '../auth.routes';
import { errorHandler } from '../../middleware/error.middleware';
import { sendOTP } from '../../services/comms.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
const phoneNumber = '+26878422613';
const input = { name: 'Chosen name', phoneNumber, email: 'chosen@example.com', password: 'ChosenPassword1' };
let rows: any[];
let tickets: any[];
let server: http.Server;
let base: string;
let tail: Promise<void>;
const session = (id: string) => jwt.sign({ id }, process.env.JWT_SECRET!);
const post = async (path: string, body: any, token?: string) => {
  const res = await fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
beforeAll(async () => {
  process.env.JWT_SECRET = 'ownership-test-secret';
  process.env.JWT_REFRESH_SECRET = 'ownership-test-refresh';
  const app = express();
  app.use(express.json());
  app.use('/organizers', organizerRoutes);
  app.use('/auth', authRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  mockReset(db);
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  rows = [{ id: 'buyer', phoneNumber, name: 'Buyer', email: 'buyer@example.com', role: 'user',
    password: await bcrypt.hash('OriginalPassword1', 4), isVerified: true, otpCode: null, otpAttempts: 0 }];
  tickets = [{ id: 'purchased-ticket', userId: 'buyer', status: 'sold' }];
  tail = Promise.resolve();
  const find = async ({ where }: any) => rows.find(row => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null;
  const update = async ({ where, data }: any) => {
    const row = await find({ where });
    Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)));
    return { ...row };
  };
  const create = async ({ data }: any) => {
    if (rows.some(row => row.phoneNumber === data.phoneNumber)) throw { code: 'P2002' };
    const row = { id: 'new-user', isVerified: false, otpAttempts: 0, ...data };
    rows.push(row);
    return { ...row };
  };
  db.user.findUnique.mockImplementation(find);
  db.user.update.mockImplementation(update);
  db.user.create.mockImplementation(create);
  db.user.findFirst.mockImplementation(async ({ where }: any) => rows.find(row =>
    where.role.in.includes(row.role) && where.OR.some((part: any) => Object.entries(part).every(([k, v]) => row[k] === v))) ?? null);
  // Model the existing PostgreSQL row-lock helper; reads must wait for the
  // lock, so concurrent upgrades see the committed role rather than a snapshot.
  db.$transaction.mockImplementation(async (fn: any) => {
    let release!: () => void;
    let locked = false;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray) => {
        expect(sql.join('?')).toContain('FOR UPDATE');
        const previous = tail;
        tail = new Promise<void>(r => { release = r; });
        await previous;
        locked = true;
        return [];
      },
      user: {
        findUnique: async (args: any) => { expect(locked).toBe(true); return find(args); },
        update, create,
      },
    };
    try { return await fn(tx); } finally { release?.(); }
  });
});

test('anonymous signup cannot mutate a verified buyer or obtain password-login tokens', async () => {
  const before = structuredClone(rows);
  const result = await post('/organizers/signup', { ...input, userId: 'buyer' });
  expect(result.status).toBe(403);
  expect(result.body.data?.token).toBeUndefined();
  expect(rows).toEqual(before);
  const login = await post('/organizers/login', { phoneNumber, password: input.password });
  expect(login.status).toBe(401);
  expect(login.body.data?.token).toBeUndefined();
  expect(tickets).toEqual([{ id: 'purchased-ticket', userId: 'buyer', status: 'sold' }]);
});

test('another authenticated account and invalid credentials cannot upgrade the buyer', async () => {
  rows.push({ id: 'attacker', phoneNumber: '+26876111111', role: 'user', isVerified: true });
  const before = structuredClone(rows);
  expect((await post('/organizers/signup', input, session('attacker'))).status).toBe(403);
  expect((await post('/organizers/signup', input, 'invalid-token')).status).toBe(401);
  expect(rows).toEqual(before);
});

test('an unverified owner session cannot upgrade', async () => {
  rows[0].isVerified = false;
  expect((await post('/organizers/signup', input, session('buyer'))).status).toBe(403);
  expect(rows[0].role).toBe('user');
});

async function verifyPhone() {
  expect((await post('/auth/request-otp', { phoneNumber })).status).toBe(200);
  const otp = rows.find(r => r.phoneNumber === phoneNumber).otpCode;
  expect(sendOTP).toHaveBeenCalledWith(phoneNumber, otp);
  const verified = await post('/auth/verify-otp', { phoneNumber, otp });
  expect(verified.status).toBe(200);
  return verified.body.data.token;
}

test('rightful buyer verifies OTP then upgrades, retaining account and purchased tickets', async () => {
  const token = await verifyPhone();
  expect((await post('/organizers/signup', input, token)).status).toBe(200);
  expect(rows[0]).toMatchObject({ id: 'buyer', role: 'organizer', isVerified: true });
  expect(tickets[0].userId).toBe(rows[0].id);
  expect(await bcrypt.compare(input.password, rows[0].password)).toBe(true);
  const login = await post('/organizers/login', { phoneNumber, password: input.password });
  expect(login.status).toBe(200);
  expect(jwt.verify(login.body.data.token, process.env.JWT_SECRET!)).toMatchObject({ id: 'buyer' });
});

test('new dashboard account verifies phone before registration', async () => {
  rows = [];
  const token = await verifyPhone();
  expect((await post('/organizers/signup', input, token)).status).toBe(200);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'new-user', role: 'organizer', isVerified: true });
});

test('new public organizer registration can still request and verify OTP', async () => {
  rows = [];
  expect((await post('/organizers/signup', input)).status).toBe(200);
  expect(rows[0].isVerified).toBe(false);
  await verifyPhone();
  expect(rows[0].isVerified).toBe(true);
});

test('concurrent upgrades serialize and reject stale role decisions', async () => {
  const token = session('buyer');
  const results = await Promise.all([
    post('/organizers/signup', input, token),
    post('/organizers/signup', { ...input, name: 'Second mutation' }, token),
    post('/organizers/signup', { ...input, name: 'Attacker' }),
  ]);
  expect(results.slice(0, 2).map(r => r.status).sort()).toEqual([200, 409]);
  expect(results[2].status).toBe(403);
  expect(rows).toHaveLength(1);
  expect(tickets[0].userId).toBe(rows[0].id);
});

test('a concurrent new-account create conflict fails closed rather than upgrading the winner', async () => {
  rows = [];
  // The account appears after the locked read found no row (Postgres does not
  // lock absent rows). Its unique phone constraint must abort this signup.
  db.$transaction.mockImplementationOnce(async (fn: any) => fn({
    $queryRaw: async () => [],
    user: {
      findUnique: async () => null,
      create: async () => {
        rows.push({ id: 'concurrent-buyer', phoneNumber, role: 'user', isVerified: true });
        throw { code: 'P2002' };
      },
      update: jest.fn(() => { throw new Error('Must not upgrade the concurrent account'); }),
    },
  }));
  expect((await post('/organizers/signup', input)).status).toBe(409);
  expect(rows).toEqual([{ id: 'concurrent-buyer', phoneNumber, role: 'user', isVerified: true }]);
});
