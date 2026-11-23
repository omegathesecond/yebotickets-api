import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

// Shared by the existing product admin controller and the corporate catalogue.
export const organizerDirectorySelect = {
  id: true,
  name: true,
  phoneNumber: true,
  email: true,
  role: true,
  isVerified: true,
  payoutApprovalStatus: true,
  payoutApprovalReviewedByAdminId: true,
  payoutApprovalReviewedByStaff: true,
  payoutApprovalReviewedAt: true,
  payoutApprovalReviewedBy: { select: { id: true, name: true } },
  companyName: true,
  companyDescription: true,
  website: true,
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

export const getOrganizerAccount = (id: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id, role: "organizer" },
    select: organizerDirectorySelect,
  });

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
