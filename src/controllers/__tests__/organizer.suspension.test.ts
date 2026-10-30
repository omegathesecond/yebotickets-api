import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../../services/comms.service', () => ({ sendOTP: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn(async () => true) }));
import prisma from '../../config/prisma';
import { protect } from '../../middleware/auth.middleware';
import { refreshTokenController } from '../auth.controller';
import { loginOrganizerController, updateOrganizerStatusController } from '../organizer.controller';
import { generateAuthTokens } from '../../services/token.service';
import { verifyOTP } from '../../services/auth.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
let user: any;
const response = () => { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; };
beforeEach(() => {
  mockReset(db);
  process.env.JWT_SECRET = 'suspension-access-test';
  process.env.JWT_REFRESH_SECRET = 'suspension-refresh-test';
  user = { id: 'org', role: 'organizer', isVerified: true, isSuspended: false, password: 'hash', otpCode: '123456', otpExpiresAt: new Date(Date.now() + 60000) };
  db.user.findUnique.mockImplementation(async () => ({ ...user }));
  db.user.findFirst.mockImplementation(async () => ({ ...user }));
  db.user.update.mockImplementation(async (args: any) => { Object.assign(user, args.data); return { ...user }; });
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
});
const bearer = async (token: string) => {
  const next = jest.fn();
  await protect({ headers: { authorization: `Bearer ${token}` } } as any, response(), next);
  return next;
};
const refresh = async (refreshToken: string) => {
  const next = jest.fn(); const res = response();
  await refreshTokenController({ body: { refreshToken } } as any, res, next);
  return { next, res };
};
const suspend = async (isSuspended: boolean) => {
  const next = jest.fn();
  await updateOrganizerStatusController({ params: { id: user.id }, body: { isSuspended } } as any, response(), next);
  expect(next).not.toHaveBeenCalled();
};
it('rejects existing access and refresh tokens and password login until explicit reactivation', async () => {
  const tokens = generateAuthTokens(user.id, user.role);
  expect(await bearer(tokens.token)).toHaveBeenCalledWith();
  await suspend(true);
  expect(user.isVerified).toBe(true);
  expect(await bearer(tokens.token)).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect((await refresh(tokens.refreshToken)).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  const next = jest.fn();
  await loginOrganizerController({ body: { phoneNumber: '+26878422613', password: 'correct' } } as any, response(), next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  await suspend(false);
  expect(await bearer(tokens.token)).toHaveBeenCalledWith();
  expect((await refresh(tokens.refreshToken)).res.status).toHaveBeenCalledWith(200);
  const loginRes = response();
  await loginOrganizerController({ body: { password: 'correct' } } as any, loginRes, jest.fn());
  expect(loginRes.status).toHaveBeenCalledWith(200);
  expect(db.user.delete).not.toHaveBeenCalled();
});
it('successful phone verification preserves suspension and its tokens cannot regain privileges', async () => {
  user.isVerified = false;
  await suspend(true);
  const result = await verifyOTP('+26878422613', '123456');
  expect(user).toMatchObject({ isVerified: true, isSuspended: true });
  expect(await bearer(result.token)).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
  expect((await refresh(result.refreshToken)).next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
});
it('ordinary unverified signup still verifies normally', async () => {
  user.role = 'user'; user.isVerified = false;
  const result = await verifyOTP('+26878422613', '123456');
  expect(user).toMatchObject({ isVerified: true, isSuspended: false });
  expect(await bearer(result.token)).toHaveBeenCalledWith();
});
it('rejects the old verification mutation rather than treating it as reactivation', async () => {
  user.isSuspended = true;
  const next = jest.fn();
  await updateOrganizerStatusController({ params: { id: user.id }, body: { isVerified: true } } as any, response(), next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  expect(db.user.update).not.toHaveBeenCalled();
});
