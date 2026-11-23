import { randomUUID } from "crypto";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { YeboLinkSendError } from "./yebolink.client";
import { sendTextMessage } from "./comms.service";
import { sendDeliveryMessage } from "./delivery-message.service";
import { deliveryAttemptOutcome } from "./delivery-state.service";
import { lockCancellationNotice } from "./cancellation-notice-state.service";

/** Only the original never-started notice is dispatched by financial completion/recovery. */
export async function dispatchCancellationNoticeForTicket(ticketId: string) {
  const notice = await prisma.ticketCancellationNotice.findUnique({
    where: { ticketId },
  });
  if (!notice)
    throw new ApiError(
      "The finalized cancellation has no saved notice intent",
      409,
    );
  return dispatchCancellationNotice(notice.id);
}

export async function dispatchCancellationNotice(id: string) {
  const attemptId = randomUUID();
  const claimed = await prisma.ticketCancellationNotice.updateMany({
    where: { id, status: "pending", attemptId: null },
    data: {
      status: "sending",
      attemptId,
      attemptedAt: new Date(),
      error: null,
    },
  });
  if (!claimed.count)
    return prisma.ticketCancellationNotice.findUniqueOrThrow({ where: { id } });
  // The claim commits before the tracked send. A crash is unknown, never a replacement.
  const original = await prisma.ticketCancellationNotice.findUniqueOrThrow({
    where: { id },
  });
  let status = "failed",
    error: string | null = null;
  try {
    if (!original.recipient)
      error =
        "The original holder has no phone number recorded; no notice was sent.";
    else {
      const history = await prisma.ticketDeliveryMessage.findMany({
        where: { cancellationNoticeId: id, dispatchAttemptId: attemptId },
      });
      if (history.length)
        throw new ApiError(
          "The original notice generation already has send history; inspect its proof",
          409,
        );
      await sendDeliveryMessage(
        { cancellationNoticeId: id },
        attemptId,
        "whatsapp",
        original.recipient,
        (metadata) =>
          sendTextMessage(original.recipient!, original.content, metadata),
      );
      status = "sent";
    }
  } catch (failure) {
    const history = await prisma.ticketDeliveryMessage.findMany({
      where: { cancellationNoticeId: id, dispatchAttemptId: attemptId },
    });
    const outcome = deliveryAttemptOutcome(history);
    // Even an intent-write failure is explicit. Only an actual rejected intent proves failed.
    status = outcome?.status === "failed" ? "failed" : "unknown";
    console.error(
      "Original cancellation notice outcome unconfirmed:",
      id,
      failure,
    );
    error =
      failure instanceof YeboLinkSendError
        ? failure.message
        : "The original notice outcome could not be confirmed. Inspect its saved message proof; it will not automatically be sent again.";
  }
  await prisma.$transaction(async (tx) => {
    await lockCancellationNotice(tx, id);
    await tx.ticketCancellationNotice.updateMany({
      where: { id, attemptId, status: "sending" },
      data: {
        status,
        error,
        ...(status === "sent" ? { sentAt: new Date() } : {}),
      },
    });
  });
  return prisma.ticketCancellationNotice.findUniqueOrThrow({ where: { id } });
}

export async function recoverCancellationNotices() {
  await prisma.ticketCancellationNotice.updateMany({
    where: {
      status: "sending",
      attemptedAt: { lt: new Date(Date.now() - 120000) },
    },
    data: {
      status: "unknown",
      error:
        "The original notice was interrupted. It may already have been sent; inspect its original proof.",
    },
  });
  const pending = await prisma.ticketCancellationNotice.findMany({
    where: { status: "pending", attemptId: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 20,
  });
  for (const notice of pending) await dispatchCancellationNotice(notice.id);
}
