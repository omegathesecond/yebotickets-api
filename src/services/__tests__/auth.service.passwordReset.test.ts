import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// --- Mock the Prisma singleton ---------------------------------------------
// auth.service imports `prisma` as the DEFAULT export of ../config/prisma.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// auth.service pulls in whatsapp.service (sendOTP) at import time; stub it so no
// real WhatsApp call is attempted while testing the password-reset flow.
jest.mock('../whatsapp.service', () => ({
  sendOTP: jest.fn(async () => ({ ok: true })),
}));

// Stub the YeboLink comms client so requestPasswordReset never hits the network.
jest.mock('../yebolink.client', () => ({
  YeboLinkClient: {
    sendSMS: jest.fn(async () => ({ messageId: 'msg-1', status: 'queued' })),
  },
}));

// Imports must come AFTER the jest.mock calls so the mocked modules are wired in.
import prisma from '../../config/prisma';
import { YeboLinkClient } from '../yebolink.client';
import { requestPasswordReset, resetPassword } from '../auth.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const sendSMSMock = YeboLinkClient.sendSMS as jest.Mock;

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
  resetCode: null,
  resetCodeExpiresAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  mockReset(prismaMock);
  sendSMSMock.mockClear();
});

describe('requestPasswordReset', () => {
  it('mints a 6-digit code, persists it with an expiry, and delivers it via YeboLink', async () => {
    const user = await buildUser();
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    const before = Date.now();
    const result = await requestPasswordReset('owner@example.com');

    expect(result.message).toMatch(/reset code/i);

    // A code with a future expiry was written to the user row.
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.where).toEqual({ id: 'user-1' });
    expect(updateArg.data.resetCode).toMatch(/^\d{6}$/);
    expect(updateArg.data.resetCodeExpiresAt.getTime()).toBeGreaterThan(before);

    // The same code was delivered over YeboLink SMS to the registered phone.
    expect(sendSMSMock).toHaveBeenCalledTimes(1);
    const smsArg = sendSMSMock.mock.calls[0][0];
    expect(smsArg.to).toBe('+26878000000');
    expect(smsArg.text).toContain(updateArg.data.resetCode);
  });

  it('rejects with 404 when no organizer account matches the email', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as any);

    await expect(requestPasswordReset('nobody@example.com')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendSMSMock).not.toHaveBeenCalled();
  });

  it('does not claim success if YeboLink delivery fails (no silent fallback)', async () => {
    const user = await buildUser();
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);
    sendSMSMock.mockRejectedValueOnce(new Error('YeboLink /messages/send 500'));

    await expect(requestPasswordReset('owner@example.com')).rejects.toThrow(/YeboLink/);
  });
});

describe('resetPassword', () => {
  const future = () => new Date(Date.now() + 10 * 60 * 1000);
  const past = () => new Date(Date.now() - 1 * 60 * 1000);

  it('sets a fresh bcrypt hash and clears the code on the happy path', async () => {
    const user = await buildUser({ resetCode: '123456', resetCodeExpiresAt: future() });
    prismaMock.user.findFirst.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    const result = await resetPassword('owner@example.com', '123456', 'NewPass1');

    expect(result).toEqual({ success: true });
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data.password).not.toBe('NewPass1');
    await expect(bcrypt.compare('NewPass1', updateArg.data.password)).resolves.toBe(true);
    // Single-use: the code is wiped so it can't be replayed.
    expect(updateArg.data.resetCode).toBeNull();
    expect(updateArg.data.resetCodeExpiresAt).toBeNull();
  });

  it('rejects with 400 for an invalid (mismatched) code', async () => {
    const user = await buildUser({ resetCode: '123456', resetCodeExpiresAt: future() });
    prismaMock.user.findFirst.mockResolvedValue(user as any);

    await expect(resetPassword('owner@example.com', '000000', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with 400 for an expired code', async () => {
    const user = await buildUser({ resetCode: '123456', resetCodeExpiresAt: past() });
    prismaMock.user.findFirst.mockResolvedValue(user as any);

    await expect(resetPassword('owner@example.com', '123456', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with 400 for an already-used code (cleared after first use)', async () => {
    // After a successful reset the columns are null — a replay finds no code.
    const user = await buildUser({ resetCode: null, resetCodeExpiresAt: null });
    prismaMock.user.findFirst.mockResolvedValue(user as any);

    await expect(resetPassword('owner@example.com', '123456', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with 404 when no organizer account matches the email', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null as any);

    await expect(resetPassword('nobody@example.com', '123456', 'NewPass1')).rejects.toBeInstanceOf(ApiError);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
