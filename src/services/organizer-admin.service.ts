import { Prisma } from "@prisma/client";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { organizerProfileMapping } from "../interfaces/user.interface";
import { withLockedUser } from "./auth.service";
const profileSelect = Object.fromEntries(
  Object.values(organizerProfileMapping).map((field) => [field, true]),
) as {
  [
    K in (typeof organizerProfileMapping)[keyof typeof organizerProfileMapping]
  ]: true;
};

// Shared by the existing product admin controller and the corporate catalogue.
export const organizerDirectorySelect = {
  id: true,
  name: true,
  phoneNumber: true,
  email: true,
  role: true,
  isVerified: true,
  isActive: true,
  payoutApprovalStatus: true,
  payoutApprovalReviewedByAdminId: true,
  payoutApprovalReviewedByStaff: true,
  payoutApprovalReviewedAt: true,
  payoutApprovalReviewedBy: { select: { id: true, name: true } },
  ...profileSelect,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export async function listOrganizers(options: {
  search?: string;
  page?: number;
  limit?: number;
  choices?: boolean;
}) {
  const where: Prisma.UserWhereInput = {
    role: "organizer",
    ...(options.search
      ? {
          OR: [
            { name: { contains: options.search, mode: "insensitive" } },
            { companyName: { contains: options.search, mode: "insensitive" } },
            { email: { contains: options.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const records = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: options.choices
      ? { id: true, name: true, companyName: true }
      : organizerDirectorySelect,
    ...(options.limit
      ? { take: options.limit, skip: ((options.page ?? 1) - 1) * options.limit }
      : {}),
  });
  const total = options.limit
    ? await prisma.user.count({ where })
    : records.length;
  return { records, total };
}

export const getOrganizerAccount = async (id: string) => {
  const account = await prisma.user.findUnique({
    where: { id, role: "organizer" },
    select: organizerDirectorySelect,
  });
  if (!account) throw new ApiError("Organiser account was not found", 404);
  return account;
};

export const setOrganizerVerification = (id: string, isVerified: boolean) =>
  prisma.user.update({
    where: { id, role: "organizer" },
    data: { isVerified },
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
      role: true,
      isVerified: true,
      companyName: true,
      createdAt: true,
      updatedAt: true,
    },
  });

/** CEO-reviewed access state; never changes ownership, verification or finances. */
export const setOrganizerAccess = async (id: string, isActive: boolean) => {
  if (!staffAdminScope.actor())
    throw new ApiError(
      "A verified corporate actor is required to change account access",
      401,
    );
  return withLockedUser({ id }, async (tx, user) => {
    if (!user || user.role !== "organizer")
      throw new ApiError("Choose an organiser account", 404);
    if (user.isActive === isActive)
      throw new ApiError("Choose a different account access state", 409);
    return tx.user.update({
      where: { id },
      data: {
        isActive,
        authVersion: { increment: 1 },
        otpCode: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        resetCodeHash: null,
        resetCodeExpiresAt: null,
        resetCodeAttempts: 0,
      },
      select: organizerDirectorySelect,
    });
  });
};

/** Retain business/financial identity: only an unused organiser may be removed. */
export async function organizerDeletionEvidence(
  id: string,
  lock = false,
  client: Prisma.TransactionClient = prisma,
) {
  if (lock)
    await client.$queryRaw`SELECT id FROM "User" WHERE id=${id} FOR UPDATE`;
  const account = await client.user.findUnique({
    where: { id, role: "organizer" },
    select: organizerDirectorySelect,
  });
  if (!account) throw new ApiError("Choose an organiser account", 404);
  const [
    events,
    tickets,
    payouts,
    accountReviews,
    purchases,
    admissions,
    notices,
  ] = await Promise.all([
    client.event.count({ where: { organizerId: id } }),
    client.ticket.count({ where: { userId: id } }),
    client.payoutRequest.count({
      where: { OR: [{ organizerId: id }, { reviewedByAdminId: id }] },
    }),
    client.user.count({ where: { payoutApprovalReviewedByAdminId: id } }),
    client.ticketPurchaseAttempt.count({ where: { userId: id } }),
    client.ticketAdmissionReceipt.count({
      where: { operatorId: id, operatorKind: "PRODUCT" },
    }),
    client.ticketCancellationNotice.count({ where: { userId: id } }),
  ]);
  const dependencies = {
    events,
    tickets,
    payouts,
    accountReviews,
    purchases,
    admissions,
    notices,
  };
  const blocked = Object.entries(dependencies).filter(([, count]) => count > 0);
  return {
    account,
    dependencies,
    canDelete: !blocked.length,
    reason: blocked.length
      ? "Keep this account because linked records must be retained: " +
        blocked.map(([name, count]) => `${name} (${count})`).join(", ") +
        "."
      : "This account has no linked event, ticket, purchase, payout, admission, notice or review history. Deletion permanently removes only this unused organiser account.",
  };
}
export const assertOrganizerDeletion = (
  evidence: Awaited<ReturnType<typeof organizerDeletionEvidence>>,
) => {
  if (!evidence.canDelete) throw new ApiError(evidence.reason, 409);
};
export const deleteOrganizer = async (
  id: string,
  requester?: { id: string; role: string },
) => {
  if (!staffAdminScope.actor() && (!requester || requester.role !== "admin"))
    throw new ApiError(
      "An administrator or verified corporate actor is required to delete an organiser",
      401,
    );
  return withLockedUser({ id }, async (tx, user) => {
    if (!user || user.role !== "organizer")
      throw new ApiError("Choose an organiser account", 404);
    const evidence = await organizerDeletionEvidence(id, false, tx);
    assertOrganizerDeletion(evidence);
    return tx.user.delete({
      where: { id, role: "organizer" },
      select: { id: true, name: true, role: true },
    });
  });
};
