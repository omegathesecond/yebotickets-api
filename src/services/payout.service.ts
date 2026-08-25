import prisma from '../config/prisma';
import { ApiError } from '../middleware/error.middleware';
import { getOrganizerEarnings } from './organizer-event.service';

/**
 * Organizer payout method + withdrawal-request flow.
 *
 * YeboTickets has no outbound disbursement integration (YeboPay is
 * inbound/collection only per platform convention) — this is a manual
 * request+admin-approval flow, mirroring how account-deletion is handled via a
 * support handoff. An organizer sets how they want to be paid, requests a
 * withdrawal against their real available balance, and an admin marks the
 * request PAID (after wiring the money manually) or REJECTED.
 *
 * The one invariant that matters: "available balance" is ALWAYS
 * totalEarnings (derived from real sold tickets, see
 * organizer-event.service.ts getOrganizerEarnings) minus any PENDING or PAID
 * payout requests — never a stored/mocked figure — so an organizer can never
 * request the same earnings twice.
 */

const RESERVED_STATUSES: Array<'pending' | 'paid'> = ['pending', 'paid'];

const PAYOUT_METHOD_SELECT = {
  payoutMethod: true,
  payoutBankName: true,
  payoutBankAccountName: true,
  payoutBankAccountNumber: true,
  payoutBankBranch: true,
  payoutMobileProvider: true,
  payoutMobileNumber: true,
} as const;

/** Sum of the organizer's PENDING + PAID payout requests — money already
 *  spoken for, whether or not it has actually moved yet. */
const getReservedAmount = async (organizerId: string): Promise<number> => {
  const reserved = await prisma.payoutRequest.aggregate({
    where: { organizerId, status: { in: RESERVED_STATUSES } },
    _sum: { amount: true },
  });
  return reserved._sum?.amount || 0;
};

/**
 * Real available balance for the organizer: total earnings from sold tickets
 * minus whatever has already been requested-or-paid out.
 */
export const getAvailableBalance = async (organizerId: string) => {
  const { totalEarnings } = await getOrganizerEarnings({ id: organizerId, role: 'organizer' });
  const reservedAmount = await getReservedAmount(organizerId);
  return {
    totalEarnings,
    reservedAmount,
    availableBalance: Math.max(0, totalEarnings - reservedAmount),
  };
};

export const getPayoutMethod = async (organizerId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: organizerId },
    select: PAYOUT_METHOD_SELECT,
  });
  if (!user) {
    throw new ApiError('Organizer not found', 404);
  }
  return user;
};

export interface PayoutMethodInput {
  payoutMethod?: 'bank_transfer' | 'mobile_money';
  payoutBankName?: string;
  payoutBankAccountName?: string;
  payoutBankAccountNumber?: string;
  payoutBankBranch?: string;
  payoutMobileProvider?: string;
  payoutMobileNumber?: string;
}

/**
 * Update the organizer's payout method. Requires the fields the chosen method
 * actually needs to pay them, so an admin fulfilling a request always has
 * somewhere real to send the money.
 */
export const updatePayoutMethod = async (organizerId: string, input: PayoutMethodInput) => {
  const {
    payoutMethod,
    payoutBankName,
    payoutBankAccountName,
    payoutBankAccountNumber,
    payoutBankBranch,
    payoutMobileProvider,
    payoutMobileNumber,
  } = input;

  if (payoutMethod === 'bank_transfer' && (!payoutBankName || !payoutBankAccountName || !payoutBankAccountNumber)) {
    throw new ApiError(
      'Bank name, account name and account number are required for bank transfer',
      400
    );
  }

  if (payoutMethod === 'mobile_money' && (!payoutMobileProvider || !payoutMobileNumber)) {
    throw new ApiError('Mobile money provider and number are required for mobile money', 400);
  }

  return prisma.user.update({
    where: { id: organizerId },
    data: {
      payoutMethod,
      payoutBankName,
      payoutBankAccountName,
      payoutBankAccountNumber,
      payoutBankBranch,
      payoutMobileProvider,
      payoutMobileNumber,
    },
    select: PAYOUT_METHOD_SELECT,
  });
};

/**
 * Create a withdrawal request. Rejects up front if the organizer has not set
 * a payout method (nowhere to send the money) or if the requested amount
 * exceeds their real available balance.
 */
export const createPayoutRequest = async (organizerId: string, amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError('Amount must be a positive number', 400);
  }

  const method = await getPayoutMethod(organizerId);
  if (!method.payoutMethod) {
    throw new ApiError('Set up a payout method before requesting a withdrawal', 400);
  }

  const { availableBalance } = await getAvailableBalance(organizerId);
  if (amount > availableBalance) {
    throw new ApiError(
      `Amount exceeds your available balance of ${availableBalance.toFixed(2)}`,
      400
    );
  }

  return prisma.payoutRequest.create({
    data: { organizerId, amount, status: 'pending' },
  });
};

export const getOrganizerPayoutRequests = async (organizerId: string) => {
  return prisma.payoutRequest.findMany({
    where: { organizerId },
    orderBy: { requestedAt: 'desc' },
  });
};

const VALID_STATUS_FILTERS = ['pending', 'paid', 'rejected'];

/** Admin: list payout requests across all organizers, optionally filtered by
 *  status. Route-level `authorize(ADMIN)` is what gates access; this function
 *  does not re-check the role (mirrors event.service.ts's convention). */
export const listPayoutRequests = async (status?: string) => {
  if (status && !VALID_STATUS_FILTERS.includes(status)) {
    throw new ApiError('Invalid status filter', 400);
  }

  return prisma.payoutRequest.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { requestedAt: 'desc' },
    include: {
      organizer: {
        select: {
          id: true,
          name: true,
          email: true,
          phoneNumber: true,
          companyName: true,
          ...PAYOUT_METHOD_SELECT,
        },
      },
    },
  });
};

/** Admin: mark a PENDING payout request PAID or REJECTED, with an optional
 *  note. Route-level `authorize(ADMIN)` gates access. */
export const updatePayoutRequestStatus = async (
  id: string,
  status: 'paid' | 'rejected',
  adminNote?: string
) => {
  if (status !== 'paid' && status !== 'rejected') {
    throw new ApiError('Status must be paid or rejected', 400);
  }

  const existing = await prisma.payoutRequest.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError('Payout request not found', 404);
  }
  if (existing.status !== 'pending') {
    throw new ApiError('Only pending payout requests can be updated', 400);
  }

  return prisma.payoutRequest.update({
    where: { id },
    data: { status, adminNote, processedAt: new Date() },
  });
};
