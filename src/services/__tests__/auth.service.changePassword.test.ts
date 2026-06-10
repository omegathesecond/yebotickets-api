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
// real network/WhatsApp call is attempted while testing the password flow.
jest.mock('../whatsapp.service', () => ({
  sendOTP: jest.fn(async () => ({ ok: true })),
}));

// Imports must come AFTER the jest.mock calls so the mocked modules are wired in.
import prisma from '../../config/prisma';
import { changePassword } from '../auth.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const buildUser = async (over: Partial<any> = {}) => ({
  id: 'user-1',
  name: 'Org Owner',
  phoneNumber: '+26878000000',
  email: 'owner@example.com',
  password: await bcrypt.hash('OldPass1', 10),
  role: 'organizer',
  isVerified: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  mockReset(prismaMock);
});

describe('changePassword', () => {
  it('updates the password with a fresh hash when the current password is correct', async () => {
    const user = await buildUser();
    prismaMock.user.findUnique.mockResolvedValue(user as any);
    prismaMock.user.update.mockResolvedValue({ ...user } as any);

    const result = await changePassword('user-1', 'OldPass1', 'NewPass1');

    expect(result).toEqual({ success: true });
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);

    const updateArg = prismaMock.user.update.mock.calls[0][0] as any;
    expect(updateArg.where).toEqual({ id: 'user-1' });
    // The stored value must be a bcrypt hash of the NEW password, never plaintext.
    expect(updateArg.data.password).not.toBe('NewPass1');
    await expect(bcrypt.compare('NewPass1', updateArg.data.password)).resolves.toBe(true);
  });

  it('rejects with 401 when the current password is incorrect', async () => {
    const user = await buildUser();
    prismaMock.user.findUnique.mockResolvedValue(user as any);

    await expect(changePassword('user-1', 'WrongPass1', 'NewPass1')).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the account has no password set', async () => {
    const user = await buildUser({ password: null });
    prismaMock.user.findUnique.mockResolvedValue(user as any);

    await expect(changePassword('user-1', 'OldPass1', 'NewPass1')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects with 404 when the user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null as any);

    await expect(changePassword('missing', 'OldPass1', 'NewPass1')).rejects.toBeInstanceOf(ApiError);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
