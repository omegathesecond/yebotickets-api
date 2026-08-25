import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Same mocking approach as organizer-event.service.test.ts: replace the prisma
// singleton with a deep mock so the payout flow (balance derivation, amount
// validation, admin fulfillment) can be exercised without a database.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import {
  getAvailableBalance,
  updatePayoutMethod,
  createPayoutRequest,
  listPayoutRequests,
  updatePayoutRequestStatus,
} from '../payout.service';
import { ApiError } from '../../middleware/error.middleware';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
});

const payoutMethodRow = (over: Partial<any> = {}) => ({
  payoutMethod: 'mobile_money',
  payoutBankName: null,
  payoutBankAccountName: null,
  payoutBankAccountNumber: null,
  payoutBankBranch: null,
  payoutMobileProvider: 'MTN',
  payoutMobileNumber: '+26876543210',
  ...over,
});

/** getOrganizerEarnings (from organizer-event.service) is exercised for real
 *  here — it reads straight from the mocked prisma — so these mocks stand in
 *  for the organizer's events + sold tickets. */
const mockEarnings = (totalEarnings: number) => {
  prismaMock.event.findMany.mockResolvedValue([{ id: 'event-1', title: 'Fest' }] as any);
  prismaMock.ticket.findMany.mockResolvedValue(
    totalEarnings > 0
      ? ([{ eventId: 'event-1', ticketType: { price: totalEarnings } }] as any)
      : ([] as any)
  );
};

describe('getAvailableBalance — real earnings minus reserved payout requests', () => {
  it('subtracts PENDING + PAID payout requests from total earnings', async () => {
    mockEarnings(1000);
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 400 } } as any);

    const result = await getAvailableBalance('org-1');

    expect(result).toEqual({ totalEarnings: 1000, reservedAmount: 400, availableBalance: 600 });
    expect(prismaMock.payoutRequest.aggregate).toHaveBeenCalledWith({
      where: { organizerId: 'org-1', status: { in: ['pending', 'paid'] } },
      _sum: { amount: true },
    });
  });

  it('never goes negative even if reserved somehow exceeds earnings', async () => {
    mockEarnings(100);
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 500 } } as any);

    const result = await getAvailableBalance('org-1');

    expect(result.availableBalance).toBe(0);
  });

  it('treats no reserved requests as zero', async () => {
    mockEarnings(250);
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: null } } as any);

    const result = await getAvailableBalance('org-1');

    expect(result).toEqual({ totalEarnings: 250, reservedAmount: 0, availableBalance: 250 });
  });
});

describe('createPayoutRequest — amount validation against available balance', () => {
  it('rejects an amount greater than the available balance', async () => {
    mockEarnings(1000);
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 0 } } as any);
    prismaMock.user.findUnique.mockResolvedValue(payoutMethodRow() as any);

    await expect(createPayoutRequest('org-1', 1000.01)).rejects.toMatchObject({
      statusCode: 400,
    } as Partial<ApiError>);
    expect(prismaMock.payoutRequest.create).not.toHaveBeenCalled();
  });

  it('rejects an amount that exceeds balance once prior requests are reserved', async () => {
    mockEarnings(1000);
    // 600 already pending/paid -> only 400 available.
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 600 } } as any);
    prismaMock.user.findUnique.mockResolvedValue(payoutMethodRow() as any);

    await expect(createPayoutRequest('org-1', 401)).rejects.toMatchObject({
      statusCode: 400,
    } as Partial<ApiError>);
  });

  it('allows an amount exactly equal to the available balance', async () => {
    mockEarnings(1000);
    prismaMock.payoutRequest.aggregate.mockResolvedValue({ _sum: { amount: 200 } } as any);
    prismaMock.user.findUnique.mockResolvedValue(payoutMethodRow() as any);
    prismaMock.payoutRequest.create.mockResolvedValue({ id: 'pr-1', amount: 800 } as any);

    const result = await createPayoutRequest('org-1', 800);

    expect(result).toMatchObject({ id: 'pr-1', amount: 800 });
    expect(prismaMock.payoutRequest.create).toHaveBeenCalledWith({
      data: { organizerId: 'org-1', amount: 800, status: 'pending' },
    });
  });

  it('rejects a zero or negative amount before touching the balance', async () => {
    await expect(createPayoutRequest('org-1', 0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPayoutRequest('org-1', -50)).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects when the organizer has not set a payout method yet', async () => {
    mockEarnings(1000);
    prismaMock.user.findUnique.mockResolvedValue(payoutMethodRow({ payoutMethod: null }) as any);

    await expect(createPayoutRequest('org-1', 100)).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.payoutRequest.aggregate).not.toHaveBeenCalled();
    expect(prismaMock.payoutRequest.create).not.toHaveBeenCalled();
  });
});

describe('updatePayoutMethod — requires the fields the chosen method needs', () => {
  it('rejects bank_transfer without account details', async () => {
    await expect(
      updatePayoutMethod('org-1', { payoutMethod: 'bank_transfer' })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('rejects mobile_money without a provider/number', async () => {
    await expect(
      updatePayoutMethod('org-1', { payoutMethod: 'mobile_money' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts a fully-specified bank_transfer method', async () => {
    prismaMock.user.update.mockResolvedValue(payoutMethodRow() as any);
    await expect(
      updatePayoutMethod('org-1', {
        payoutMethod: 'bank_transfer',
        payoutBankName: 'Standard Bank',
        payoutBankAccountName: 'Jane Organizer',
        payoutBankAccountNumber: '1234567890',
      })
    ).resolves.toBeDefined();
    expect(prismaMock.user.update).toHaveBeenCalled();
  });
});

describe('listPayoutRequests — admin listing, optionally filtered by status', () => {
  it('rejects an invalid status filter', async () => {
    await expect(listPayoutRequests('bogus')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes a valid status filter through to the query', async () => {
    prismaMock.payoutRequest.findMany.mockResolvedValue([] as any);
    await listPayoutRequests('pending');
    expect(prismaMock.payoutRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending' } })
    );
  });
});

describe('updatePayoutRequestStatus — admin fulfillment', () => {
  it('throws 404 when the payout request does not exist', async () => {
    prismaMock.payoutRequest.findUnique.mockResolvedValue(null as any);
    await expect(updatePayoutRequestStatus('missing', 'paid')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses to update a request that is already resolved', async () => {
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ id: 'pr-1', status: 'paid' } as any);
    await expect(updatePayoutRequestStatus('pr-1', 'rejected')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(prismaMock.payoutRequest.update).not.toHaveBeenCalled();
  });

  it('marks a pending request paid and stamps processedAt', async () => {
    prismaMock.payoutRequest.findUnique.mockResolvedValue({ id: 'pr-1', status: 'pending' } as any);
    prismaMock.payoutRequest.update.mockResolvedValue({ id: 'pr-1', status: 'paid' } as any);

    await updatePayoutRequestStatus('pr-1', 'paid', 'Wired via bank transfer');

    expect(prismaMock.payoutRequest.update).toHaveBeenCalledWith({
      where: { id: 'pr-1' },
      data: { status: 'paid', adminNote: 'Wired via bank transfer', processedAt: expect.any(Date) },
    });
  });
});
