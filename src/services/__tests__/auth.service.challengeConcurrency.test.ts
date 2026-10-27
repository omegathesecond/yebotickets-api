import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../comms.service', () => ({ sendOTP: jest.fn(), sendTextMessage: jest.fn() }));
jest.mock('../token.service', () => ({ generateAuthTokens: jest.fn(() => ({ token: 'access', refreshToken: 'refresh' })) }));
import prisma from '../../config/prisma';
import { requestOTP, requestPasswordReset, resetPassword, verifyOTP } from '../auth.service';
import { generateAuthTokens } from '../token.service';
import { sendOTP, sendTextMessage } from '../comms.service';

const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
const phone = '+26878422613';
const identifier = { email: 'owner@example.com' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

// A stateful model of PostgreSQL User row locks. UPDATE and SELECT FOR UPDATE
// share the same queue; transaction reads must occur after lock acquisition.
// Failed transactions roll back, so throwing an auth error inside the
// transaction would fail the independent-attempt assertions below.
let row: any;
let tail: Promise<void>;
let beforeWrite: (() => Promise<void>) | undefined;
let readCount: number;
let issuanceUpdate: ReturnType<typeof deferred>;
async function acquire() {
  const previous = tail;
  const release = deferred();
  tail = previous.then(() => release.promise);
  await previous;
  return release.resolve;
}
beforeEach(async () => {
  mockReset(db);
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  tail = Promise.resolve();
  beforeWrite = undefined;
  readCount = 0;
  issuanceUpdate = deferred();
  row = {
    id: 'user-1', phoneNumber: phone, email: identifier.email, role: 'organizer',
    otpCode: '123456', otpExpiresAt: new Date(Date.now() + 60000), otpAttempts: 0,
    resetCodeHash: await bcrypt.hash('123456', 4),
    resetCodeExpiresAt: new Date(Date.now() + 60000), resetCodeAttempts: 0,
    password: 'old-password', isVerified: false,
  };
  const read = async () => ({ ...row });
  db.user.findUnique.mockImplementation(read);
  db.user.findFirst.mockImplementation(read);
  db.user.update.mockImplementation(async ({ data }: any) => {
    issuanceUpdate.resolve();
    const release = await acquire();
    try { Object.assign(row, data); return { ...row }; } finally { release(); }
  });
  db.$transaction.mockImplementation(async (fn: any) => {
    let release: (() => void) | undefined;
    let snapshot: any;
    const tx = {
      $queryRaw: async (sql: TemplateStringsArray, ...values: any[]) => {
        expect(sql.join('?')).toMatch(/SELECT "id" FROM "User" WHERE "(id|phoneNumber)" = \? FOR UPDATE/);
        expect(values).toHaveLength(1);
        release = await acquire();
        snapshot = { ...row };
        return [{ id: row.id }];
      },
      user: {
        findUnique: async () => {
          expect(release).toBeDefined();
          readCount++;
          return { ...row };
        },
        update: async ({ data }: any) => {
          expect(release).toBeDefined();
          if (beforeWrite) { const hook = beforeWrite; beforeWrite = undefined; await hook(); }
          Object.assign(row, data);
          return { ...row };
        },
      },
    };
    try { return await fn(tx); }
    catch (e) { if (snapshot) row = snapshot; throw e; }
    finally { release?.(); }
  });
});
afterEach(() => jest.restoreAllMocks());

for (const kind of ['otp', 'reset'] as const) {
  const verify = (code: string) => kind === 'otp'
    ? verifyOTP(phone, code) : resetPassword(identifier, code, 'NewPassword1');
  const codeField = kind === 'otp' ? 'otpCode' : 'resetCodeHash';
  const attemptsField = kind === 'otp' ? 'otpAttempts' : 'resetCodeAttempts';
  const expiryField = kind === 'otp' ? 'otpExpiresAt' : 'resetCodeExpiresAt';

  describe(`${kind} challenge concurrency`, () => {
    it('allows exactly one simultaneous correct verifier to consume the code', async () => {
      const results = await Promise.allSettled([verify('123456'), verify('123456')]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(row[codeField]).toBeNull();
      expect(readCount).toBe(2);
      if (kind === 'otp') expect(generateAuthTokens).toHaveBeenCalledTimes(1);
      else expect(await bcrypt.compare('NewPassword1', row.password)).toBe(true);
    });

    it('counts parallel misses independently and locks out a queued correct verifier', async () => {
      const entered = deferred();
      const resume = deferred();
      beforeWrite = async () => { entered.resolve(); await resume.promise; };
      const first = verify('000000');
      const firstResult = Promise.allSettled([first]);
      await entered.promise;
      const rest = Promise.allSettled([
        verify('000000'), verify('000000'), verify('000000'), verify('000000'), verify('123456'),
      ]);
      resume.resolve();
      const results = [...await firstResult, ...await rest];
      expect(results.every(r => r.status === 'rejected')).toBe(true);
      expect(row[codeField]).toBeNull();
      if (kind === 'otp') {
        expect(results[4]).toMatchObject({ status: 'rejected', reason: { statusCode: 429 } });
        expect(generateAuthTokens).not.toHaveBeenCalled();
      } else expect(row.password).toBe('old-password');
    });

    it('retains each increment below the cap', async () => {
      await Promise.allSettled([verify('000000'), verify('000000'), verify('000000')]);
      expect(row[attemptsField]).toBe(3);
      expect(row[codeField]).not.toBeNull();
    });

    it('checks expiry after waiting for the row lock', async () => {
      const release = await acquire();
      const result = Promise.allSettled([verify('123456')]);
      row[expiryField] = new Date(Date.now() - 1);
      release();
      expect((await result)[0].status).toBe('rejected');
      expect(generateAuthTokens).not.toHaveBeenCalled();
      expect(row.password).toBe('old-password');
    });

    it.each(kind === 'reset' ? ['wrong', 'correct', 'expired'] as const : ['wrong', 'correct'] as const)('protects replacement issuance from an in-flight %s verifier and sends without a lock', async (mode) => {
      const entered = deferred();
      const resume = deferred();
      beforeWrite = async () => { entered.resolve(); await resume.promise; };
      if (mode === 'expired') row[expiryField] = new Date(Date.now() - 1);
      const stale = Promise.allSettled([verify(mode === 'correct' ? '123456' : '000000')]);
      await entered.promise;
      const send = kind === 'otp' ? sendOTP : sendTextMessage;
      (send as jest.Mock).mockImplementation(async () => {
        // A send can acquire the User lock: issuance has already released it.
        const release = await acquire();
        release();
      });
      const issuance = kind === 'otp' ? requestOTP(phone) : requestPasswordReset(identifier);
      await issuanceUpdate.promise;
      expect(row[attemptsField]).toBe(0);
      resume.resolve();
      await stale;
      await issuance;
      expect(row[attemptsField]).toBe(0);
      expect(row[codeField]).not.toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
}
