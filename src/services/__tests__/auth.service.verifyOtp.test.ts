import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// --- Mock the Prisma singleton ---------------------------------------------
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// Stub comms so no real YeboLink/network call is attempted at import time.
jest.mock('../comms.service', () => ({
  sendOTP: jest.fn(async () => ({ ok: true })),
}));

// Stub token minting so a successful verify doesn't need real JWT secrets.
jest.mock('../token.service', () => ({
  generateAuthTokens: jest.fn(() => ({ token: 'access-tok', refreshToken: 'refresh-tok' })),
}));

// Imports must come AFTER the jest.mock calls.
import prisma from '../../config/prisma';
import { verifyOTP } from '../auth.service';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const futureExpiry = () => new Date(Date.now() + 5 * 60 * 1000);

const buildUser = (over: Partial<any> = {}) => ({
  id: 'user-1',
  name: 'Ticket Buyer',
  phoneNumber: '+26878422613',
  email: null,
  password: null,
  role: 'user',
  isVerified: false,
  otpCode: '123456',
  otpExpiresAt: futureExpiry(),
  otpAttempts: 0,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  mockReset(prismaMock);
});

describe('verifyOTP brute-force lockout', () => {
  it('verifies and resets the attempt counter on a correct code', async () => {
    const user = buildUser({ otpAttempts: 2 });
    prismaMock.user.findUnique.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user, isVerified: true } as any);

    const result = await verifyOTP('+26878422613', '123456');

    expect(result.token).toBe('access-tok');
    expect(result.refreshToken).toBe('refresh-tok');
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data).toMatchObject({
      otpCode: null,
      otpExpiresAt: null,
      otpAttempts: 0,
      isVerified: true,
    });
  });

  it('increments the counter and reports remaining attempts on a wrong code', async () => {
    const user = buildUser({ otpAttempts: 1 });
    prismaMock.user.findUnique.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue(user as any);

    await expect(verifyOTP('+26878422613', '000000')).rejects.toMatchObject({
      statusCode: 400,
    });

    // Counter bumped 1 -> 2, code left intact so the user can retry.
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data).toEqual({ otpAttempts: 2 });
  });

  it('invalidates the code with 429 once the attempt cap is reached', async () => {
    // Already had 4 failed attempts; this 5th wrong guess trips the lockout.
    const user = buildUser({ otpAttempts: 4 });
    prismaMock.user.findUnique.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue(user as any);

    await expect(verifyOTP('+26878422613', '000000')).rejects.toMatchObject({
      statusCode: 429,
    });

    // The OTP is wiped so further guesses are impossible until a new request.
    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.data).toMatchObject({
      otpCode: null,
      otpExpiresAt: null,
      otpAttempts: 0,
    });
  });

  it('rejects with 400 when no OTP was requested', async () => {
    const user = buildUser({ otpCode: null, otpExpiresAt: null });
    prismaMock.user.findUnique.mockResolvedValue(user as any);

    await expect(verifyOTP('+26878422613', '123456')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
