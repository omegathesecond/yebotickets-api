import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// --- Mock the Prisma singleton ---------------------------------------------
// auth.service imports `prisma` as the DEFAULT export of ../config/prisma.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// auth.service pulls in comms.service (sendOTP/sendTextMessage) at import
// time; stub it so no real comms call is attempted while testing the
// password-reset flow.
jest.mock('../comms.service', () => ({
  sendOTP: jest.fn(async () => ({ ok: true })),
  sendTextMessage: jest.fn(async () => ({ ok: true })),
}));

// Imports must come AFTER the jest.mock calls so the mocked modules are wired in.
import prisma from '../../config/prisma';
import { sendTextMessage } from '../comms.service';
import { requestPasswordReset, resetPassword } from '../auth.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const sendTextMessageMock = sendTextMessage as jest.Mock;

const buildUser = async (over: Partial<any> = {}) => ({
  id: 'user-1',
  name: 'Org Owner',
  phoneNumber: '+26878000000',
  email: 'owner@example.com',
  password: await bcrypt.hash('OldPass1', 10),
  role: 'organizer',
  isVerified: true,
  otpCode: null,
  otpExpiresAt: null,
  resetCodeHash: null,
  resetCodeExpiresAt: null,
  resetCodeAttempts: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  mockReset(prismaMock);
  sendTextMessageMock.mockClear();
});

describe('requestPasswordReset', () => {
  it('mints a 6-digit code, persists a HASH of it with an expiry, and delivers the plaintext code via YeboLink', async () => {
    const user = await buildUser();
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    const before = Date.now();
    const result = await requestPasswordReset({ email: 'owner@example.com' });

    expect(result.message).toMatch(/reset code/i);

    // A HASH (not the plaintext code) with a future expiry was written to the user row.
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.where).toEqual({ id: 'user-1' });
    expect(updateArg.data.resetCodeHash).toEqual(expect.any(String));
    expect(updateArg.data.resetCodeHash).not.toMatch(/^\d{6}$/);
    expect(updateArg.data.resetCodeExpiresAt.getTime()).toBeGreaterThan(before);

    // The plaintext code was delivered over YeboLink to the registered phone,
    // and that plaintext code matches the persisted hash.
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
    const [toPhone, text] = sendTextMessageMock.mock.calls[0];
    expect(toPhone).toBe('+26878000000');
    const sentCode = text.match(/\b\d{6}\b/)?.[0];
    expect(sentCode).toBeDefined();
    await expect(bcrypt.compare(sentCode as string, updateArg.data.resetCodeHash)).resolves.toBe(true);
  });

  it('returns the same generic message for an unknown identifier and does no work (anti-enumeration)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as any);

    const result = await requestPasswordReset({ email: 'nobody@example.com' });

    // Identical shape to the success case — a caller can't tell them apart.
    expect(result.message).toMatch(/reset code/i);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('does not claim success if YeboLink delivery fails (no silent fallback)', async () => {
    const user = await buildUser();
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);
    sendTextMessageMock.mockRejectedValueOnce(new Error('YeboLink /messages/send 500'));

    await expect(requestPasswordReset({ email: 'owner@example.com' })).rejects.toThrow(/YeboLink/);
  });
});

describe('resetPassword', () => {
  const future = () => new Date(Date.now() + 10 * 60 * 1000);
  const past = () => new Date(Date.now() - 1 * 60 * 1000);
  const identifier = { email: 'owner@example.com' };

  it('sets a fresh bcrypt hash and clears the reset code on the happy path', async () => {
    const codeHash = await bcrypt.hash('123456', 10);
    const user = await buildUser({ resetCodeHash: codeHash, resetCodeExpiresAt: future() });
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    const result = await resetPassword(identifier, '123456', 'NewPass1');

    expect(result).toEqual({ success: true });
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data.password).not.toBe('NewPass1');
    await expect(bcrypt.compare('NewPass1', updateArg.data.password)).resolves.toBe(true);
    // Single-use: the code is wiped so it can't be replayed.
    expect(updateArg.data.resetCodeHash).toBeNull();
    expect(updateArg.data.resetCodeExpiresAt).toBeNull();
  });

  it('rejects with 400 for an invalid (mismatched) code and counts the failed attempt', async () => {
    const codeHash = await bcrypt.hash('123456', 10);
    const user = await buildUser({ resetCodeHash: codeHash, resetCodeExpiresAt: future(), resetCodeAttempts: 0 });
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    await expect(resetPassword(identifier, '000000', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    // The miss is recorded but the (still-valid) code is NOT burned yet.
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data.resetCodeAttempts).toBe(1);
    expect(updateArg.data.password).toBeUndefined();
  });

  it('burns the code after too many wrong attempts (brute-force cap)', async () => {
    const codeHash = await bcrypt.hash('123456', 10);
    const user = await buildUser({ resetCodeHash: codeHash, resetCodeExpiresAt: future(), resetCodeAttempts: 4 });
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    await expect(resetPassword(identifier, '000000', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    // 5th miss: the code is cleared so it can no longer be guessed.
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data.resetCodeHash).toBeNull();
    expect(updateArg.data.resetCodeExpiresAt).toBeNull();
  });

  it('rejects with 400 for an expired code and burns it', async () => {
    const codeHash = await bcrypt.hash('123456', 10);
    const user = await buildUser({ resetCodeHash: codeHash, resetCodeExpiresAt: past() });
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    await expect(resetPassword(identifier, '123456', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data.resetCodeHash).toBeNull();
    expect(updateArg.data.password).toBeUndefined();
  });

  it('rejects with 400 for an already-used code (cleared after first use)', async () => {
    // After a successful reset the columns are null — a replay finds no code.
    const user = await buildUser({ resetCodeHash: null, resetCodeExpiresAt: null });
    prismaMock.user.findFirst.mockResolvedValue(user as any);

    await expect(resetPassword(identifier, '123456', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with a generic 400 when no account matches the identifier (anti-enumeration)', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as any);

    await expect(resetPassword({ email: 'nobody@example.com' }, '123456', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(resetPassword({ email: 'nobody@example.com' }, '123456', 'NewPass1')).rejects.toBeInstanceOf(
      ApiError
    );
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
