import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { ApiError } from "../middleware/error.middleware";
import { CURRENCY } from "../config/platform";
import { prepareReviewedEffect } from "./externalEffect";
import { recordStaffOperation, StaffOperationContext } from "./audit";
import { operationStore } from "./receipts";

const fail = (message: string) => new ApiError(message, 409);
export async function prepareCorporateRefund<T>(
  context: StaffOperationContext,
  ticket: any,
  run: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prepareReviewedEffect(
    context,
    "admin_refund_ticket",
    {
      ticketId: ticket.id,
      uniqueCode: ticket.uniqueCode,
      eventId: ticket.eventId,
      chargeId: ticket.paymentRef,
      amount: ticket.amountPaid,
      currency: CURRENCY,
    },
    run,
  );
}

/** The audit and operation store, never a caller-supplied product identity, own this association. */
async function originalOperation(
  client: Prisma.TransactionClient,
  id: string,
  ticketId: string,
) {
  const rows = await client.$queryRawUnsafe<any[]>(
      "SELECT * FROM staff_admin_audit WHERE id=$1::uuid",
      id,
    ),
    audit = rows[0];
  const receipt = await operationStore(client).get(id);
  if (
    !audit ||
    !receipt ||
    audit.operation !== "admin_refund_ticket" ||
    audit.staffId !== receipt.actorId ||
    audit.targetKey !== "yebotickets:ticket:" + ticketId ||
    audit.parameters.id !== ticketId
  )
    throw fail("The original corporate refund audit and receipt do not match");
  return { audit, receipt };
}
export async function finishCorporateRefund(
  client: Prisma.TransactionClient,
  id: string,
  ticket: any,
  status: "REFUNDED" | "CANCELLED_FREE",
) {
  const { audit } = await originalOperation(client, id, ticket.id);
  const intent = audit.parameters.reviewedEffect;
  if (
    !intent ||
    intent.ticketId !== ticket.id ||
    intent.chargeId !== ticket.paymentRef ||
    intent.amount !== ticket.amountPaid ||
    intent.currency !== CURRENCY
  )
    throw fail("The original reviewed refund terms changed");
  const notice = await client.ticketCancellationNotice.findUnique({
    where: { ticketId: ticket.id },
  });
  if (!notice)
    throw fail("The finalized cancellation has no saved notice intent");
  const data = {
    ticketId: ticket.id,
    uniqueCode: ticket.uniqueCode,
    status,
    amount: ticket.amountPaid,
    currency: CURRENCY,
    originalOperationId: id,
    refundAttemptId: ticket.refundAttemptId ?? null,
    gatewayRequestId: ticket.refundGatewayRequestId ?? null,
    refundRef: ticket.refundRef ?? null,
    cancellationNoticeId: notice.id,
    note: "This receipt proves the ticket/refund outcome. It does not claim holder-notification delivery.",
  };
  if (status === "REFUNDED")
    await recordStaffOperation(
      {
        id: randomUUID(),
        actor: {
          id: audit.staffId,
          name: audit.staffName,
          email: audit.staffEmail,
        },
        name: "admin_refund_ticket_finalized",
        targetKey: audit.targetKey,
        parameters: { originalOperationId: id, ticketId: ticket.id },
        reviewedVersion: "",
      },
      client,
      data,
    );
  const body = { success: true, data, operation: { id, state: "completed" } };
  await operationStore(client).finish(id, "completed", 200, body);
  return body;
}
export async function failCorporateRefund(
  client: Prisma.TransactionClient,
  id: string,
  ticketId: string,
  message: string,
) {
  const { audit } = await originalOperation(client, id, ticketId);
  const body = {
    success: false,
    error: message,
    data: {
      ticketId,
      status: "NOT_REFUNDED",
      originalOperationId: id,
      note: "No successful refund is claimed. The paid ticket remains unchanged.",
    },
    operation: { id, state: "failed" },
  };
  await recordStaffOperation(
    {
      id: randomUUID(),
      actor: {
        id: audit.staffId,
        name: audit.staffName,
        email: audit.staffEmail,
      },
      name: "admin_refund_ticket_failed",
      targetKey: audit.targetKey,
      parameters: { originalOperationId: id, ticketId },
      reviewedVersion: "",
    },
    client,
    { message },
  );
  await operationStore(client).finish(id, "failed", 502, body);
}
