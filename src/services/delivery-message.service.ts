import { randomUUID } from "crypto";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { lockOrderDelivery } from "./delivery-state.service";
import {
  YeboLinkClient,
  YeboLinkMessageResult,
  YeboLinkSendError,
  assertMessageAcceptance,
} from "./yebolink.client";

/** Separate durable send history; no invented receipt or automatic resend after lost acknowledgement. */
export async function sendDeliveryMessage(
  deliveryOrderId: string,
  dispatchAttemptId: string,
  channel: "whatsapp" | "email",
  recipient: string,
  send: (metadata: Record<string, string>) => Promise<YeboLinkMessageResult>,
) {
  const id = randomUUID();
  // Intentionally use the owning client outside the Event/Ticket transaction:
  // the original intent survives rollback after the gateway accepted a send.
  await prisma.ticketDeliveryMessage.create({
    data: { id, deliveryOrderId, dispatchAttemptId, channel, recipient },
  });
  let accepted: YeboLinkMessageResult;
  try {
    accepted = await send({
      product: "yebotickets",
      ticketDeliveryMessageId: id,
      ticketDeliveryOrderId: deliveryOrderId,
      dispatchAttemptId,
    });
    assertMessageAcceptance(accepted);
  } catch (error) {
    const definite = error instanceof YeboLinkSendError && !error.ambiguous;
    await prisma.ticketDeliveryMessage.update({
      where: { id },
      data: {
        state: definite ? "failed" : "unknown",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  // Failure to save acknowledgement is ambiguous: never choose another channel
  // or infer success. The already-committed intent remains for inspection.
  await prisma.ticketDeliveryMessage.update({
    where: { id },
    data: {
      state: "accepted",
      messageId: accepted.messageId,
      acceptanceStatus: accepted.status,
      gatewayStatus: accepted.status,
    },
  });
  return accepted;
}

const date = (value: string | undefined) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new ApiError(
      "Original gateway receipt contains an invalid timestamp",
      502,
    );
  return new Date(value);
};
const progress: Record<string, number> = {
  scheduled: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};
export const deliveryMessageView = (row: any) => ({
  id: row.id,
  deliveryOrderId: row.deliveryOrderId,
  dispatchAttemptId: row.dispatchAttemptId,
  channel: row.channel,
  state: row.state,
  messageId: row.messageId,
  acceptanceStatus: row.acceptanceStatus,
  gatewayStatus: row.gatewayStatus,
  gatewayError: row.gatewayError,
  error: row.error,
  providerMessageId: row.providerMessageId,
  gatewaySentAt: row.gatewaySentAt,
  gatewayDeliveredAt: row.gatewayDeliveredAt,
  gatewayReadAt: row.gatewayReadAt,
  gatewayFailedAt: row.gatewayFailedAt,
  checkedAt: row.checkedAt,
  createdAt: row.createdAt,
  note: "Accepted or sent does not prove customer receipt. Gateway delivered/read is the recorded provider evidence. A missing message identity cannot be replaced with a guessed receipt.",
});

/** Read the exact original message. No send, channel change or retry occurs here. */
export async function checkDeliveryMessage(id: string) {
  const original = await prisma.ticketDeliveryMessage.findUnique({
    where: { id },
  });
  if (!original)
    throw new ApiError("Original delivery attempt was not found", 404);
  if (!original.messageId)
    throw new ApiError(
      "This attempt has no confirmed message identity. Its outcome cannot be established by a receipt read; do not assume it was not sent.",
      409,
    );
  const receipt = await YeboLinkClient.getMessage(original.messageId);
  if (
    receipt.channel !== original.channel ||
    receipt.recipient !== original.recipient ||
    receipt.metadata.product !== "yebotickets" ||
    receipt.metadata.ticketDeliveryMessageId !== id ||
    receipt.metadata.ticketDeliveryOrderId !== original.deliveryOrderId ||
    receipt.metadata.dispatchAttemptId !== original.dispatchAttemptId
  )
    throw new ApiError(
      "Gateway receipt does not belong to this original ticket delivery",
      409,
    );
  const timestamps = {
    gatewaySentAt: date(receipt.sent_at),
    gatewayDeliveredAt: date(receipt.delivered_at),
    gatewayReadAt: date(receipt.read_at),
    gatewayFailedAt: date(receipt.failed_at),
  };
  // A stale provider read must never erase a stronger confirmed outcome.
  return prisma.$transaction(async (tx) => {
    await lockOrderDelivery(tx, original.deliveryOrderId);
    await tx.$queryRaw`SELECT id FROM "TicketDeliveryMessage" WHERE id=${id} FOR UPDATE`;
    const current = await tx.ticketDeliveryMessage.findUniqueOrThrow({
      where: { id },
    });
    const previous = current.gatewayStatus;
    if (
      current.providerMessageId &&
      receipt.provider_message_id &&
      current.providerMessageId !== receipt.provider_message_id
    )
      throw new ApiError(
        "Gateway provider identity changed for the original message",
        409,
      );
    if (
      previous &&
      previous !== receipt.status &&
      ((previous in progress &&
        receipt.status in progress &&
        progress[receipt.status] < progress[previous]) ||
        (["delivered", "read"].includes(previous) &&
          !(receipt.status in progress)) ||
        ["failed", "cancelled"].includes(previous))
    )
      throw new ApiError(
        "Gateway receipt conflicts with the saved delivery evidence; retain the original outcome for reconciliation",
        409,
      );
    const row = await tx.ticketDeliveryMessage.update({
      where: { id },
      data: {
        gatewayStatus: receipt.status,
        gatewayError: receipt.error_message ?? null,
        ...(receipt.provider_message_id
          ? { providerMessageId: receipt.provider_message_id }
          : {}),
        ...Object.fromEntries(
          Object.entries(timestamps).filter(([, value]) => value !== null),
        ),
        checkedAt: new Date(),
      },
    });
    if (
      [
        "scheduled",
        "queued",
        "sent",
        "delivered",
        "read",
        "dispatching",
      ].includes(receipt.status)
    )
      await tx.ticketOrderDelivery.updateMany({
        where: {
          id: current.deliveryOrderId,
          attemptId: current.dispatchAttemptId,
          status: { in: ["unknown", "sending"] },
        },
        data: {
          status: "sent",
          channel: current.channel,
          error: null,
          ...(timestamps.gatewaySentAt
            ? { sentAt: timestamps.gatewaySentAt }
            : {}),
        },
      });
    return deliveryMessageView(row);
  });
}
