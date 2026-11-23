import { validateParams, hashIntent } from "@omevision/product-admin-boundary";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { operations } from "./operations";
import { ticketRefundTerms } from "../services/ticket-refund-terms";
import { CURRENCY } from "../config/platform";
import { validateOperationInput } from "./inputs";
const tables: Record<string, string> = {
  user: "User",
  event: "Event",
  payoutRequest: "PayoutRequest",
  ticketType: "TicketType",
  ticket: "Ticket",
};
const fail = (message: string, status = 400) => new ApiError(message, status);
export function checked(name: string, parameters: Record<string, any>) {
  const op = Object.prototype.hasOwnProperty.call(operations, name)
    ? operations[name]
    : null;
  if (!op) throw fail("Unknown Tickets administration operation", 404);
  const result = validateParams(
    {
      type: "object",
      properties: op.properties,
      required: op.required,
      additionalProperties: false,
    },
    parameters,
  );
  if (!result.ok)
    throw fail("Invalid operation fields: " + result.errors.join(", "));
  return op;
}
export const targetKey = (name: string, parameters: Record<string, any>) => {
  const op = checked(name, parameters);
  if (!op.target) throw fail("Choose an operation that changes a record");
  return "yebotickets:" + op.target.model + ":" + parameters[op.target.field];
};
export async function review(
  name: string,
  parameters: Record<string, any>,
  lock = false,
) {
  const op = checked(name, parameters);
  if (name === "admin_check_refund") {
    const locks = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "TicketRefundLock" WHERE "attemptId"=$1${lock ? " FOR UPDATE" : ""}`,
      parameters.attemptId,
    );
    const ticket = await prisma.ticket.findUniqueOrThrow({
        where: { id: parameters.id },
      }),
      claim = locks[0];
    if (
      claim
        ? claim.ticketId !== ticket.id
        : ticket.refundAttemptId !== parameters.attemptId ||
          ticket.paymentStatus !== "REFUNDED" ||
          ticket.status !== "cancelled"
    )
      throw fail(
        "The selected original refund no longer matches this ticket",
        409,
      );
    const intent = {
      id: ticket.id,
      attemptId: parameters.attemptId,
      chargeId: claim?.chargeId ?? ticket.paymentRef,
      amount: claim?.amount ?? ticket.amountPaid,
      currency: CURRENCY,
    };
    return {
      version: hashIntent({ name, parameters, intent }),
      workspace: {
        ...intent,
        name: ticket.uniqueCode,
        status: claim?.phase ?? "REFUNDED",
        policy:
          "Check only the original refund proof. This action never sends another refund.",
      },
    };
  }
  const table = op.target && tables[op.target.model];
  if (!table) throw fail("This operation has no editable target");
  await validateOperationInput(name, parameters);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "${table}" WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    parameters[op.target.field],
  );
  if (!rows.length) throw fail("The product record was not found", 404);
  if (op.target.model === "user" && rows[0].role !== "organizer")
    throw fail("Choose an organiser account", 404);
  let refundContext: any;
  if (name === "admin_refund_ticket") {
    const event = await prisma.event.findUniqueOrThrow({
      where: { id: rows[0].eventId },
      select: { id: true, title: true, isCancelled: true },
    });
    const terms = ticketRefundTerms({ ...rows[0], event });
    const holds = await prisma.ticketRefundLock.findMany({
      where: {
        OR: [
          { ticketId: rows[0].id },
          ...(rows[0].paymentRef ? [{ chargeId: rows[0].paymentRef }] : []),
        ],
      },
    });
    if (holds.length)
      throw fail(
        "This payment already has an unresolved original refund. Check that attempt instead.",
        409,
      );
    refundContext = { event, terms, holds };
  }
  const inventory =
    op.target.model === "ticketType" || name === "admin_delete_event"
      ? await prisma.$queryRawUnsafe<any[]>(
          `SELECT id,status,"userId","updatedAt" FROM "Ticket" WHERE "${op.target.model === "ticketType" ? "ticketTypeId" : "eventId"}"=$1 ORDER BY id${lock ? " FOR UPDATE" : ""}`,
          parameters[op.target.field],
        )
      : undefined;
  const tiers =
    name === "admin_delete_event"
      ? await prisma.$queryRawUnsafe<any[]>(
          `SELECT * FROM "TicketType" WHERE "eventId"=$1 ORDER BY id${lock ? " FOR UPDATE" : ""}`,
          parameters[op.target.field],
        )
      : undefined;
  return {
    version: hashIntent({
      name,
      parameters,
      rows,
      inventory,
      tiers,
      refundContext,
    }),
    workspace: {
      id: rows[0].id,
      name: rows[0].name ?? rows[0].title ?? op.title,
      ...(refundContext
        ? {
            ticketCode: rows[0].uniqueCode,
            event: refundContext.event.title,
            amount: refundContext.terms.amount,
            currency: CURRENCY,
            paymentRef: rows[0].paymentRef,
            isCheckedIn: rows[0].isCheckedIn,
            policy: refundContext.terms.paid
              ? "Refund only this ticket’s recorded amount to its original payment. Pending or lost replies retain the original attempt."
              : "Cancel this explicitly free ticket. No payment is sent.",
          }
        : {}),
      ...(name === "admin_delete_event"
        ? {
            ticketRecords: inventory!.length,
            tierDefinitions: tiers!.length,
            policy:
              "Delete only an empty event. Its reviewed empty tier definitions will also be removed. Issued inventory and payment history must be kept.",
          }
        : {}),
      ...(op.target.model === "ticketType"
        ? {
            eventId: rows[0].eventId,
            price: rows[0].price,
            capacity: rows[0].quantity,
            inventoryRecords: inventory!.length,
            policy:
              "Capacity includes sold, reserved and cancelled records. Generation adds available tickets; it does not sell, charge or send them. Deletion retains issued ticket and payment history.",
          }
        : {}),
      ...(op.target.model === "payoutRequest"
        ? {
            amount: rows[0].amount,
            currency: rows[0].currency,
            status: rows[0].status,
            destinationMethod: rows[0].destinationMethod,
            destinationAccountName: rows[0].destinationAccountName,
            destinationAccountNumber: rows[0].destinationAccountNumber,
            policy:
              "Approving reserves the existing payout request. Recording paid stores an already completed external transfer; it sends no payment.",
          }
        : {}),
    },
  };
}
