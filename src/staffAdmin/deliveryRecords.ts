import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { deliveryMessageView } from "../services/delivery-message.service";
const ticketSelect = {
  id: true,
  uniqueCode: true,
  status: true,
  isCheckedIn: true,
  event: { select: { id: true, title: true, isCancelled: true } },
  user: { select: { id: true, name: true } },
} as const;
/** Existing delivery work, not a second communications dashboard or invented proof. */
export async function listDeliveryRecords(p: Record<string, any>) {
  const where = p.status ? { status: p.status } : {};
  const [rows, total] = await Promise.all([
    prisma.ticketOrderDelivery.findMany({
      where,
      include: { tickets: { select: ticketSelect } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: ((p.page ?? 1) - 1) * (p.limit ?? 20),
      take: p.limit ?? 20,
    }),
    prisma.ticketOrderDelivery.count({ where }),
  ]);
  return {
    records: rows.map(({ tickets, ...row }) => ({
      ...row,
      eventNames: [...new Set(tickets.map((ticket) => ticket.event.title))],
      buyerNames: [
        ...new Set(tickets.map((ticket) => ticket.user?.name).filter(Boolean)),
      ],
      ticketCount: tickets.length,
    })),
    total,
  };
}
export async function deliveryRecord(id: string) {
  const row = await prisma.ticketOrderDelivery.findUnique({
    where: { id },
    include: { tickets: { select: ticketSelect } },
  });
  if (!row)
    throw new ApiError("The original ticket delivery was not found", 404);
  return {
    ...row,
    tickets: row.tickets.map((ticket) => ({
      id: ticket.id,
      ticketCode: ticket.uniqueCode,
      status: ticket.status,
      isCheckedIn: ticket.isCheckedIn,
      event: ticket.event.title,
      eventCancelled: ticket.event.isCancelled,
      buyerName: ticket.user?.name ?? null,
    })),
    note: "Sent is the source's recorded message-acceptance state. It does not prove customer receipt. Unknown delivery may already have sent a message; it is never automatically resent.",
  };
}

export async function listDeliveryMessages(p: Record<string, any>) {
  const where = { deliveryOrderId: p.id };
  const [rows, total] = await Promise.all([
    prisma.ticketDeliveryMessage.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: ((p.page ?? 1) - 1) * (p.limit ?? 20),
      take: p.limit ?? 20,
    }),
    prisma.ticketDeliveryMessage.count({ where }),
  ]);
  return { records: rows.map(deliveryMessageView), total };
}
export async function deliveryMessageRecord(id: string) {
  const row = await prisma.ticketDeliveryMessage.findUnique({ where: { id } });
  if (!row)
    throw new ApiError("Original ticket delivery attempt was not found", 404);
  return deliveryMessageView(row);
}
