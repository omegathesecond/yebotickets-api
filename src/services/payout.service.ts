import prisma from '../config/prisma';
import { ApiError } from '../middleware/error.middleware';
import { CURRENCY, getPlatformFeePercent } from '../config/platform';
import {
  getOrganizerStatement,
  splitPayoutFee,
  RESERVED_PAYOUT_STATUSES,
  OrganizerStatement,
} from './settlement.service';

/**
 * Organizer payout destination + withdrawal workflow.
 *
 * Ticket money is charged into the PLATFORM's YeboPay merchant account and
 * YeboPay does not yet expose a payouts rail, so disbursement is a manual
 * transfer an admin performs out of band. This module models the workflow
 * around that transfer; {@link markPayoutRequestPaid} is the SINGLE seam where
 * the money is declared to have moved. When YeboPay ships /v1/payouts, that one
 * function calls it and records the returned reference — nothing else here
 * changes.
 *
 * Lifecycle: pending (requested) -> approved -> paid, with pending|approved ->
 * rejected as the exit. `paid` and `rejected` are terminal.
 *
 * The invariant that matters: what an organizer may withdraw is ALWAYS
 * recomputed by settlement.service.ts from real ticket rows minus fees, payouts
 * and open requests — never a stored balance — so the same earnings can never
 * be withdrawn twice.
 */

const PAYOUT_METHOD_SELECT = {
  payoutMethod: true,
  payoutBankName: true,
  payoutBankAccountName: true,
  payoutBankAccountNumber: true,
  payoutBankBranch: true,
  payoutMobileProvider: true,
  payoutMobileNumber: true,
  payoutApprovalStatus: true,
} as const;

/** Postgres unique-violation. Raised by the partial unique index that allows at
 *  most one open payout request per organizer (see the settlement migration). */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** The organizer's balance + per-event statement. */
export const getOrganizerBalance = async (organizerId: string): Promise<OrganizerStatement> =>
  getOrganizerStatement(organizerId);

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
 * Update the organizer's payout destination. Requires whatever the chosen
 * method actually needs to pay them, so an admin fulfilling a request always
 * has somewhere real to send the money.
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

/** Freeze where the money is going, so editing the profile later cannot
 *  redirect a request an admin is already fulfilling. */
const destinationSnapshot = (method: Awaited<ReturnType<typeof getPayoutMethod>>) =>
  method.payoutMethod === 'bank_transfer'
    ? {
        destinationMethod: method.payoutMethod,
        destinationAccountName: method.payoutBankAccountName,
        destinationAccountNumber: method.payoutBankAccountNumber,
        destinationBankName: method.payoutBankName,
        destinationDetail: method.payoutBankBranch,
      }
    : {
        destinationMethod: method.payoutMethod,
        destinationAccountName: method.payoutBankAccountName,
        destinationAccountNumber: method.payoutMobileNumber,
        destinationBankName: null,
        destinationDetail: method.payoutMobileProvider,
      };

/**
 * Create a withdrawal request for a NET amount, validated against the real
 * available balance. Rejects when there is nowhere to send the money, when a
 * request is already open, or when the amount exceeds what is withdrawable.
 */
export const createPayoutRequest = async (organizerId: string, amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApiError('Amount must be a positive number', 400);
  }

  const method = await getPayoutMethod(organizerId);

  // Staff review gate — deliberately independent of User.isVerified, which is
  // set automatically by phone-OTP with no human review. See the schema
  // comment on PayoutApprovalStatus.
  if (method.payoutApprovalStatus !== 'approved') {
    throw new ApiError('Your organizer account is pending approval before you can request a payout', 403);
  }

  if (!method.payoutMethod) {
    throw new ApiError('Set up a payout method before requesting a withdrawal', 400);
  }

  // One open request at a time: an organizer with two open requests could
  // request the same balance twice before either is settled.
  const open = await prisma.payoutRequest.findFirst({
    where: { organizerId, status: { in: [...RESERVED_PAYOUT_STATUSES] } },
    select: { id: true, status: true },
  });
  if (open) {
    throw new ApiError(
      'You already have a payout request awaiting processing. Wait for it to be settled before requesting another.',
      409
    );
  }

  const statement = await getOrganizerStatement(organizerId);
  if (amount > statement.availableBalance) {
    throw new ApiError(
      `Amount exceeds your available balance of ${statement.currency} ${statement.availableBalance.toFixed(2)}`,
      400
    );
  }

  try {
    return await prisma.payoutRequest.create({
      data: {
        organizerId,
        ...splitPayoutFee(amount, statement.feePercent),
        currency: statement.currency,
        status: 'pending',
        ...destinationSnapshot(method),
      },
    });
  } catch (error: any) {
    // Lost the race against a concurrent request: the partial unique index
    // rejected the second insert. Surface the same conflict the check above
    // would have produced rather than a raw 500.
    if (error?.code === PRISMA_UNIQUE_VIOLATION) {
      throw new ApiError(
        'You already have a payout request awaiting processing. Wait for it to be settled before requesting another.',
        409
      );
    }
    throw error;
  }
};

export const getOrganizerPayoutRequests = async (organizerId: string) =>
  prisma.payoutRequest.findMany({
    where: { organizerId },
    orderBy: { requestedAt: 'desc' },
  });

const VALID_STATUS_FILTERS = ['pending', 'approved', 'paid', 'rejected'];

/** Admin: payout requests across all organizers, optionally filtered by status.
 *  Route-level `authorize(ADMIN)` is what gates access; this function does not
 *  re-check the role (mirrors event.service.ts's convention). */
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
      reviewedByAdmin: { select: { id: true, name: true } },
    },
  });
};

const VALID_PAYOUT_APPROVAL_STATUSES = ['unreviewed', 'approved', 'rejected'];

/**
 * Admin: set an organizer's payout-approval review status — the gate
 * {@link createPayoutRequest} checks, independent of phone-OTP `isVerified`.
 * Route-level `authorize(ADMIN)` is what restricts access; this function does
 * not re-check the role (mirrors listPayoutRequests's convention).
 *
 * `adminId` is the authenticated admin making the call (from `req.user.id`)
 * — recorded alongside the transition so a fraud-review decision on real
 * money movement is always traceable to a specific admin and timestamp.
 */
export const setPayoutApprovalStatus = async (organizerId: string, status: string, adminId: string) => {
  if (!VALID_PAYOUT_APPROVAL_STATUSES.includes(status)) {
    throw new ApiError('payoutApprovalStatus must be unreviewed, approved or rejected', 400);
  }

  try {
    return await prisma.user.update({
      where: { id: organizerId, role: 'organizer' },
      data: {
        payoutApprovalStatus: status as any,
        payoutApprovalReviewedByAdminId: adminId,
        payoutApprovalReviewedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        companyName: true,
        payoutApprovalStatus: true,
        payoutApprovalReviewedByAdminId: true,
        payoutApprovalReviewedAt: true,
        payoutApprovalReviewedBy: { select: { id: true, name: true } },
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      throw new ApiError('Organizer not found', 404);
    }
    throw error;
  }
};

/** Load a request for an admin transition, asserting the transition is legal. */
const loadForTransition = async (id: string, allowedFrom: string[]) => {
  const existing = await prisma.payoutRequest.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError('Payout request not found', 404);
  }
  if (!allowedFrom.includes(existing.status)) {
    throw new ApiError(
      `A ${existing.status} payout request cannot be changed from here (expected: ${allowedFrom.join(' or ')})`,
      400
    );
  }
  return existing;
};

/** Admin: approve a requested payout — cleared to pay, money has NOT moved yet.
 *  Stays reserved against the balance, so approving changes nothing the
 *  organizer can withdraw. `adminId` (the authenticated admin) is recorded as
 *  the reviewer for compliance traceability. */
export const approvePayoutRequest = async (id: string, adminId: string, adminNote?: string) => {
  await loadForTransition(id, ['pending']);
  const now = new Date();
  return prisma.payoutRequest.update({
    where: { id },
    data: {
      status: 'approved',
      approvedAt: now,
      processedAt: now,
      adminNote,
      reviewedByAdminId: adminId,
      reviewedAt: now,
    },
  });
};

/** Admin: reject a payout request, releasing its amount back to the
 *  organizer's available balance. Allowed while approved too — nothing has
 *  moved until it is marked paid. `adminId` (the authenticated admin) is
 *  recorded as the reviewer for compliance traceability. */
export const rejectPayoutRequest = async (id: string, adminId: string, adminNote?: string) => {
  await loadForTransition(id, ['pending', 'approved']);
  const now = new Date();
  return prisma.payoutRequest.update({
    where: { id },
    data: { status: 'rejected', processedAt: now, adminNote, reviewedByAdminId: adminId, reviewedAt: now },
  });
};

/**
 * Admin: record that an APPROVED payout has actually been transferred.
 *
 * This is the seam the YeboPay payouts rail drops into: today the transfer
 * happens out of band and the admin supplies its reference, tomorrow this
 * function calls /v1/payouts and records the reference it returns. Either way
 * `reference` is mandatory — an untraceable settled payout cannot be
 * reconciled against the platform's own account. `adminId` (the authenticated
 * admin) is recorded as the reviewer for compliance traceability.
 */
export const markPayoutRequestPaid = async (
  id: string,
  adminId: string,
  reference: string,
  adminNote?: string
) => {
  if (!reference || !reference.trim()) {
    throw new ApiError('An external transfer reference is required to mark a payout paid', 400);
  }
  await loadForTransition(id, ['approved']);
  const now = new Date();
  return prisma.payoutRequest.update({
    where: { id },
    data: {
      status: 'paid',
      paidAt: now,
      processedAt: now,
      reference: reference.trim(),
      adminNote,
      reviewedByAdminId: adminId,
      reviewedAt: now,
    },
  });
};

export interface PayoutStatusUpdate {
  adminNote?: string;
  reference?: string;
}

/** Admin: single entry point behind PATCH /organizers/admin/payout-requests/:id.
 *  `adminId` (the authenticated admin from `req.user.id`) is threaded through
 *  to every transition so it lands in `reviewedByAdminId`/`reviewedAt`. */
export const updatePayoutRequestStatus = async (
  id: string,
  status: 'approved' | 'paid' | 'rejected',
  adminId: string,
  { adminNote, reference }: PayoutStatusUpdate = {}
) => {
  switch (status) {
    case 'approved':
      return approvePayoutRequest(id, adminId, adminNote);
    case 'rejected':
      return rejectPayoutRequest(id, adminId, adminNote);
    case 'paid':
      return markPayoutRequestPaid(id, adminId, reference ?? '', adminNote);
    default:
      throw new ApiError('Status must be approved, paid or rejected', 400);
  }
};

/** Re-exported so callers have one import for "the platform's money settings". */
export { CURRENCY, getPlatformFeePercent };
