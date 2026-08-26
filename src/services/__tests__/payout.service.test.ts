import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import {
  updatePayoutMethod,
  listPayoutRequests,
  createPayoutRequest,
  approvePayoutRequest,
  rejectPayoutRequest,
  markPayoutRequestPaid,
  updatePayoutRequestStatus,
  getOrganizerBalance,
} from '../payout.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const ORG = 'org-1';
/** Long past / far future, so the eligibility boundary holds against real `now`. */
const FINISHED = new Date('2020-01-02T00:00:00Z');
const UPCOMING = new Date('2099-01-02T00:00:00Z');

const originalFeePercent = process.env.PLATFORM_FEE_PERCENT;

const BANK_METHOD = {
  payoutMethod: 'bank_transfer' as const,
  payoutBankName: 'Standard Bank',
  payoutBankAccountName: 'Sipho Dlamini',
  payoutBankAccountNumber: '9012345678',
  payoutBankBranch: 'Mbabane',
  payoutMobileProvider: null,
  payoutMobileNumber: null,
};

/**
 * A minimal in-memory stand-in for the PayoutRequest table, including the
 * partial unique index that permits at most one OPEN (pending|approved) request
 * per organizer. Using a real store rather than hand-fed return values means a
 * status transition genuinely moves money between the reserved and paid-out
 * buckets, so the "exactly once" invariant is actually exercised.
 */
type PayoutRow = { id: string; organizerId: string; amount: number; status: string; [k: string]: any };
const OPEN_STATUSES = ['pending', 'approved'];
let store: PayoutRow[] = [];

const uniqueViolation = () => {
  const err: any = new Error('Unique constraint failed on PayoutRequest_one_open_per_organizer');
  err.code = 'P2002';
  return err;
};

const wirePayoutTable = ({ enforceIndexOnly = false } = {}) => {
  prismaMock.payoutRequest.aggregate.mockImplementation((async (args: any) => {
    const status = args.where.status;
    const wanted: string[] = typeof status === 'string' ? [status] : status.in;
    const amount = store
      .filter((r) => r.organizerId === args.where.organizerId && wanted.includes(r.status))
      .reduce((sum, r) => sum + r.amount, 0);
    return { _sum: { amount } };
  }) as any);

  prismaMock.payoutRequest.findFirst.mockImplementation((async (args: any) => {
    // `enforceIndexOnly` simulates the TOCTOU race: both callers read before
    // either has written, so the pre-check sees nothing and only the database
    // index can stop the second insert.
    if (enforceIndexOnly) return null;
    const wanted: string[] = args.where.status.in;
    return (
      store.find((r) => r.organizerId === args.where.organizerId && wanted.includes(r.status)) ?? null
    );
  }) as any);

  prismaMock.payoutRequest.create.mockImplementation((async (args: any) => {
    const row: PayoutRow = { id: `payout-${store.length + 1}`, requestedAt: new Date(), ...args.data };
    if (store.some((r) => r.organizerId === row.organizerId && OPEN_STATUSES.includes(r.status))) {
      throw uniqueViolation();
    }
    store.push(row);
    return row;
  }) as any);

  prismaMock.payoutRequest.findUnique.mockImplementation((async (args: any) =>
    store.find((r) => r.id === args.where.id) ?? null) as any);

  prismaMock.payoutRequest.update.mockImplementation((async (args: any) => {
    const row = store.find((r) => r.id === args.where.id);
    if (!row) throw new Error(`no payout row ${args.where.id}`);
    Object.assign(row, args.data);
    return row;
  }) as any);
};

/** Sales the organizer has earned: one finished event, `gross` charged on it. */
const wireSales = (gross: number, endDate: Date = FINISHED) => {
  prismaMock.event.findMany.mockResolvedValue([
    { id: 'e1', title: 'Finished Fest', endDate, isCancelled: false },
  ] as any);
  prismaMock.ticket.findMany.mockResolvedValue([
    { eventId: 'e1', status: 'sold', amountPaid: gross, ticketType: { price: gross } },
  ] as any);
};

const wireMethod = (method: any = BANK_METHOD) => {
  prismaMock.user.findUnique.mockResolvedValue(method as any);
};

beforeEach(() => {
  mockReset(prismaMock);
  store = [];
  delete process.env.PLATFORM_FEE_PERCENT;
  wirePayoutTable();
  wireMethod();
});

afterAll(() => {
  if (originalFeePercent === undefined) delete process.env.PLATFORM_FEE_PERCENT;
  else process.env.PLATFORM_FEE_PERCENT = originalFeePercent;
});

describe('createPayoutRequest — guarding the balance', () => {
  it('REJECTS a request larger than the available balance', async () => {
    wireSales(1000);

    await expect(createPayoutRequest(ORG, 1000.01)).rejects.toMatchObject({ statusCode: 400 });
    expect(store).toHaveLength(0);
  });

  it('allows a request for exactly the available balance', async () => {
    wireSales(1000);

    await expect(createPayoutRequest(ORG, 1000)).resolves.toMatchObject({ amount: 1000 });
  });

  it('rejects a request for money held back behind an unfinished event', async () => {
    wireSales(1000, UPCOMING);

    await expect(createPayoutRequest(ORG, 100)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a request for the pre-fee gross once a commission is set', async () => {
    process.env.PLATFORM_FEE_PERCENT = '10';
    wireSales(1000);

    // 1000 gross, 100 fee — only 900 is withdrawable.
    await expect(createPayoutRequest(ORG, 1000)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPayoutRequest(ORG, 900)).resolves.toMatchObject({ amount: 900 });
  });

  it('rejects a request when no payout method is on file', async () => {
    wireSales(1000);
    wireMethod({ ...BANK_METHOD, payoutMethod: null });

    await expect(createPayoutRequest(ORG, 100)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-positive amount', async () => {
    wireSales(1000);

    await expect(createPayoutRequest(ORG, 0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPayoutRequest(ORG, -50)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('REJECTS a second request while one is still open', async () => {
    wireSales(1000);

    await createPayoutRequest(ORG, 200);
    await expect(createPayoutRequest(ORG, 100)).rejects.toMatchObject({ statusCode: 409 });
    expect(store).toHaveLength(1);
  });

  it('rejects a second request that races past the check, via the database index', async () => {
    wireSales(1000);
    await createPayoutRequest(ORG, 200);

    // Re-wire so the pre-check is blind: only the unique index stands between
    // two concurrent requests and a double withdrawal of the same balance.
    wirePayoutTable({ enforceIndexOnly: true });

    await expect(createPayoutRequest(ORG, 100)).rejects.toMatchObject({ statusCode: 409 });
    expect(store).toHaveLength(1);
  });

  it('allows a fresh request once the previous one is rejected', async () => {
    wireSales(1000);
    const first = await createPayoutRequest(ORG, 200);
    await rejectPayoutRequest(first.id, 'Wrong account number');

    await expect(createPayoutRequest(ORG, 200)).resolves.toMatchObject({ status: 'pending' });
  });

  it('SNAPSHOTS the destination so a later profile edit cannot redirect the money', async () => {
    wireSales(1000);

    const request = await createPayoutRequest(ORG, 200);

    expect(request).toMatchObject({
      destinationMethod: 'bank_transfer',
      destinationBankName: 'Standard Bank',
      destinationAccountName: 'Sipho Dlamini',
      destinationAccountNumber: '9012345678',
      destinationDetail: 'Mbabane',
    });
  });

  it('snapshots the mobile-money number when that is the chosen method', async () => {
    wireSales(1000);
    wireMethod({
      ...BANK_METHOD,
      payoutMethod: 'mobile_money',
      payoutMobileProvider: 'MTN MoMo',
      payoutMobileNumber: '26878422613',
    });

    const request = await createPayoutRequest(ORG, 200);

    expect(request).toMatchObject({
      destinationMethod: 'mobile_money',
      destinationAccountNumber: '26878422613',
      destinationDetail: 'MTN MoMo',
    });
  });

  it('FREEZES the fee on the row so a later rate change cannot restate it', async () => {
    process.env.PLATFORM_FEE_PERCENT = '10';
    wireSales(1000);

    const request = await createPayoutRequest(ORG, 900);
    expect(request).toMatchObject({
      amount: 900,
      feePercent: 10,
      feeAmount: 100,
      grossAmount: 1000,
      currency: 'SZL',
    });

    // The business doubles its commission afterwards; the settled row is unmoved.
    process.env.PLATFORM_FEE_PERCENT = '20';
    expect(store[0]).toMatchObject({ feePercent: 10, feeAmount: 100, grossAmount: 1000 });
  });
});

describe('admin fulfilment — approve, pay, reject', () => {
  it('moves the balance from reserved to paid-out EXACTLY ONCE across approve then pay', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);

    const requested = await getOrganizerBalance(ORG);
    expect(requested).toMatchObject({ reserved: 400, paidOut: 0, availableBalance: 600 });

    await approvePayoutRequest(request.id);
    const approved = await getOrganizerBalance(ORG);
    // Still reserved, not yet paid — and crucially NOT counted twice.
    expect(approved).toMatchObject({ reserved: 400, paidOut: 0, availableBalance: 600 });

    await markPayoutRequestPaid(request.id, 'FT24081900123');
    const paid = await getOrganizerBalance(ORG);
    expect(paid).toMatchObject({ reserved: 0, paidOut: 400, availableBalance: 600 });
  });

  it('records when the money moved and the transfer reference', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await approvePayoutRequest(request.id);

    const paid = await markPayoutRequestPaid(request.id, '  FT24081900123  ', 'Wired via Standard Bank');

    expect(paid.status).toBe('paid');
    expect(paid.reference).toBe('FT24081900123');
    expect(paid.adminNote).toBe('Wired via Standard Bank');
    expect(paid.approvedAt).toBeInstanceOf(Date);
    expect(paid.paidAt).toBeInstanceOf(Date);
  });

  it('REFUSES to mark a payout paid without an external reference', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await approvePayoutRequest(request.id);

    await expect(markPayoutRequestPaid(request.id, '   ')).rejects.toMatchObject({ statusCode: 400 });
    expect(store[0].status).toBe('approved');
  });

  it('refuses to pay a request that was never approved', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);

    await expect(markPayoutRequestPaid(request.id, 'FT1')).rejects.toMatchObject({ statusCode: 400 });
    expect(store[0].status).toBe('pending');
  });

  it('refuses to re-pay an already paid request', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await approvePayoutRequest(request.id);
    await markPayoutRequestPaid(request.id, 'FT1');

    await expect(markPayoutRequestPaid(request.id, 'FT2')).rejects.toMatchObject({ statusCode: 400 });
    expect(await getOrganizerBalance(ORG)).toMatchObject({ paidOut: 400 });
  });

  it('refuses to approve a request twice', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await approvePayoutRequest(request.id);

    await expect(approvePayoutRequest(request.id)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('RELEASES the amount back to the balance when a request is rejected', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    expect(await getOrganizerBalance(ORG)).toMatchObject({ availableBalance: 600 });

    await rejectPayoutRequest(request.id, 'Account details did not match');

    expect(await getOrganizerBalance(ORG)).toMatchObject({
      reserved: 0,
      paidOut: 0,
      availableBalance: 1000,
    });
  });

  it('can reject a request that was approved but never paid', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await approvePayoutRequest(request.id);

    await expect(rejectPayoutRequest(request.id)).resolves.toMatchObject({ status: 'rejected' });
    expect(await getOrganizerBalance(ORG)).toMatchObject({ availableBalance: 1000 });
  });

  it('404s on an unknown payout request', async () => {
    await expect(approvePayoutRequest('nope')).rejects.toMatchObject({ statusCode: 404 } as Partial<ApiError>);
  });
});

describe('updatePayoutRequestStatus — the admin PATCH entry point', () => {
  it('dispatches approve, then paid with its reference', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);

    await updatePayoutRequestStatus(request.id, 'approved', { adminNote: 'Cleared' });
    expect(store[0].status).toBe('approved');

    await updatePayoutRequestStatus(request.id, 'paid', { reference: 'FT99' });
    expect(store[0]).toMatchObject({ status: 'paid', reference: 'FT99' });
  });

  it('rejects a paid transition with no reference', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);
    await updatePayoutRequestStatus(request.id, 'approved');

    await expect(updatePayoutRequestStatus(request.id, 'paid', {})).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects an unknown status', async () => {
    wireSales(1000);
    const request = await createPayoutRequest(ORG, 400);

    await expect(
      updatePayoutRequestStatus(request.id, 'settled' as any, {})
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});


describe('updatePayoutMethod — requires the fields the chosen method needs', () => {
  it('rejects bank_transfer without account details', async () => {
    await expect(
      updatePayoutMethod(ORG, { payoutMethod: 'bank_transfer', payoutBankName: 'Standard Bank' })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects mobile_money without a provider and number', async () => {
    await expect(
      updatePayoutMethod(ORG, { payoutMethod: 'mobile_money', payoutMobileNumber: '26878422613' })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('accepts a fully specified bank transfer', async () => {
    prismaMock.user.update.mockResolvedValue(BANK_METHOD as any);

    await expect(
      updatePayoutMethod(ORG, {
        payoutMethod: 'bank_transfer',
        payoutBankName: 'Standard Bank',
        payoutBankAccountName: 'Sipho Dlamini',
        payoutBankAccountNumber: '9012345678',
      })
    ).resolves.toMatchObject({ payoutMethod: 'bank_transfer' });
  });
});

describe('listPayoutRequests — admin listing', () => {
  it('rejects an unknown status filter', async () => {
    await expect(listPayoutRequests('settled')).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.payoutRequest.findMany).not.toHaveBeenCalled();
  });

  it('passes each valid status filter through to the query', async () => {
    prismaMock.payoutRequest.findMany.mockResolvedValue([] as any);

    for (const status of ['pending', 'approved', 'paid', 'rejected']) {
      await listPayoutRequests(status);
      expect(prismaMock.payoutRequest.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { status } })
      );
    }
  });

  it('lists every request when no filter is given', async () => {
    prismaMock.payoutRequest.findMany.mockResolvedValue([] as any);

    await listPayoutRequests();

    expect(prismaMock.payoutRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined })
    );
  });
});
