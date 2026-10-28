import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../comms.service', () => ({ sendOTP: jest.fn(), sendTextMessage: jest.fn() }));
import prisma from '../../config/prisma';
import { changePassword, resetPassword, verifyOTP } from '../auth.service';
import { generateAuthTokens } from '../token.service';
import { protect } from '../../middleware/auth.middleware';
import { refreshTokenController } from '../../controllers/auth.controller';
import { loginOrganizerController } from '../../controllers/organizer.controller';

const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
let row: any;
let other: any;
let afterRefreshRead: (() => Promise<void>) | undefined;
beforeEach(async () => {
  mockReset(db);
  process.env.JWT_SECRET = 'session-test';
  process.env.JWT_REFRESH_SECRET = 'refresh-test';
  row = { id: 'owner', role: 'organizer', sessionVersion: 0, isVerified: true,
    password: await bcrypt.hash('OldPass1', 4), resetCodeHash: await bcrypt.hash('123456', 4),
    resetCodeExpiresAt: new Date(Date.now() + 60000), resetCodeAttempts: 0 };
  other = { ...row, id: 'other' };
  afterRefreshRead = undefined;
  db.user.findFirst.mockImplementation(async () => ({ ...row }));
  db.user.findUnique.mockImplementation(async (args: any) => {
    const snapshot = { ...(args.where.id === 'other' ? other : row) };
    if (args.select?.sessionVersion && !args.select?.name && afterRefreshRead) await afterRefreshRead();
    return snapshot;
  });
  db.user.update.mockImplementation(async ({ data }: any) => {
    const { sessionVersion, ...rest } = data;
    Object.assign(row, rest);
    if (sessionVersion) row.sessionVersion += sessionVersion.increment;
    return { ...row };
  });
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});
const access = async (token: string) => {
  const next = jest.fn();
  await protect({ headers: { authorization: 'Bearer ' + token } } as any, {} as any, next);
  return next.mock.calls[0]?.[0];
};
const refresh = async (refreshToken: string) => {
  const next = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await refreshTokenController({ body: { refreshToken } } as any, res as any, next);
  return { error: next.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};
describe('authoritative session revocation', () => {
  it.each(['reset', 'change'])('%s rejects old bearer and refresh while another account and new login work', async kind => {
    const old = generateAuthTokens(row.id, row.role, row.sessionVersion);
    const unaffected = generateAuthTokens(other.id, other.role, other.sessionVersion);
    expect(await access(old.token)).toBeUndefined();
    expect((await refresh(old.refreshToken)).error).toBeUndefined();
    if (kind === 'reset') await resetPassword({ email: 'owner@example.com' }, '123456', 'NewPass1');
    else await changePassword(row.id, 'OldPass1', 'NewPass1');
    expect(row.sessionVersion).toBe(1);
    expect(await access(old.token)).toMatchObject({ statusCode: 401 });
    expect((await refresh(old.refreshToken)).error).toMatchObject({ statusCode: 401 });
    expect(await access(unaffected.token)).toBeUndefined();
    expect((await refresh(unaffected.refreshToken)).error).toBeUndefined();
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await loginOrganizerController({ body: { email: 'owner@example.com', password: 'NewPass1' } } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    const tokens = res.json.mock.calls[0][0].data;
    expect(await access(tokens.token)).toBeUndefined();
    expect((await refresh(tokens.refreshToken)).error).toBeUndefined();
  });
  it.each(['wrong code', 'expired code', 'wrong password'])('%s does not revoke', async kind => {
    const tokens = generateAuthTokens(row.id, row.role, 0);
    if (kind === 'expired code') row.resetCodeExpiresAt = new Date(0);
    const operation = kind === 'wrong password'
      ? changePassword(row.id, 'wrong', 'NewPass1')
      : resetPassword({ email: 'owner@example.com' }, kind === 'wrong code' ? '000000' : '123456', 'NewPass1');
    await expect(operation).rejects.toBeDefined();
    expect(row.sessionVersion).toBe(0);
    expect(await access(tokens.token)).toBeUndefined();
    expect((await refresh(tokens.refreshToken)).error).toBeUndefined();
  });
  it.each(['reset', 'change'])('refresh snapshot before %s cannot mint a usable session after commit', async kind => {
    const old = generateAuthTokens(row.id, row.role, 0);
    let release!: () => void;
    let read!: () => void;
    const readStarted = new Promise<void>(r => { read = r; });
    const gate = new Promise<void>(r => { release = r; });
    afterRefreshRead = async () => { read(); await gate; };
    const pending = refresh(old.refreshToken);
    await readStarted;
    if (kind === 'reset') await resetPassword({ email: 'owner@example.com' }, '123456', 'NewPass1');
    else await changePassword(row.id, 'OldPass1', 'NewPass1');
    release();
    const result = await pending;
    afterRefreshRead = undefined;
    expect(result.error).toBeUndefined();
    expect(await access(result.body.accessToken)).toMatchObject({ statusCode: 401 });
    expect((await refresh(result.body.refreshToken)).error).toMatchObject({ statusCode: 401 });
  });
  it('OTP verification mints the current version after credential changes', async () => {
    row.sessionVersion = 3;
    row.otpCode = '123456';
    row.otpExpiresAt = new Date(Date.now() + 60000);
    const tokens = await verifyOTP('+26878422613', '123456');
    expect(await access(tokens.token)).toBeUndefined();
    expect((await refresh(tokens.refreshToken)).error).toBeUndefined();
    expect(jwt.decode(tokens.token)).toMatchObject({ sessionVersion: 3 });
  });
  it('rejects tokens without a version and refresh tokens used as bearer tokens', async () => {
    expect(await access(jwt.sign({ id: row.id }, process.env.JWT_SECRET!))).toMatchObject({ statusCode: 401 });
    expect((await refresh(jwt.sign({ id: row.id, type: 'refresh' }, process.env.JWT_REFRESH_SECRET!))).error)
      .toMatchObject({ statusCode: 401 });
    process.env.JWT_REFRESH_SECRET = process.env.JWT_SECRET;
    expect(await access(generateAuthTokens(row.id, row.role, 0).refreshToken)).toMatchObject({ statusCode: 401 });
  });
});
