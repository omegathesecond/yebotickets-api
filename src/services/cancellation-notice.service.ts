import { randomUUID } from "crypto";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { YeboLinkSendError } from "./yebolink.client";
import { sendTextMessage } from "./comms.service";
import { sendDeliveryMessage } from "./delivery-message.service";
import {
  deliveryAttemptOutcome,
  deliveryDispatchPolicy,
  deliveryGeneration,
} from "./delivery-state.service";
import {
  lockCancellationNotice,
  noticeReviewEvidence,
  assertNoticeReview,
} from "./cancellation-notice-state.service";

/** One source-owned claim for automatic initial work and exact reviewed retries. */
export async function claimCancellationNotice(
  id: string,
  manual = false,
  acknowledge = false,
  attemptId: string = randomUUID(),
) {
  const evidence = await noticeReviewEvidence(id),
    row = evidence.order;
  if (manual)
    assertNoticeReview(evidence, acknowledge, deliveryGeneration(row));
  // The worker only starts the original queued intent. It never reclaims a send.
  else if (row.status !== "pending" || row.attemptId !== null) return {};
  const claim = await prisma.ticketCancellationNotice.updateMany({
    where: { id, status: row.status, attemptId: row.attemptId },
    data: {
      status: "sending",
      attemptId,
      attemptedAt: new Date(),
      error: null,
    },
  });
  return claim.count ? { attemptId } : {};
}

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

/** Only the already committed generation may dispatch; immutable send intent survives work rollback. */
export async function dispatchClaimedCancellationNotice(
  id: string,
  attemptId: string,
  finalize?: () => Promise<unknown>,
  beforeSend?: () => Promise<void>,
) {
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockCancellationNotice(tx, id);
      const evidence = await noticeReviewEvidence(id),
        row = evidence.order;
      if (row.status !== "sending" || row.attemptId !== attemptId)
        return { status: row.status, error: row.error };
      const original = deliveryAttemptOutcome(
        evidence.messages.filter(
          (message) => message.dispatchAttemptId === attemptId,
        ),
      );
      if (original)
        return {
          status: original.status === "accepted" ? "sent" : original.status,
          error: original.error,
        };
      const policy = deliveryDispatchPolicy(evidence);
      if (!policy.canRetry && policy.status === "sent")
        return { status: "suppressed", error: policy.reason };
      if (!row.recipient)
        return {
          status: "failed",
          error:
            "The original holder has no phone number recorded; no notice was sent.",
        };
      if (beforeSend)
        try {
          await beforeSend();
        } catch (error) {
          if (!(error instanceof ApiError) || error.statusCode !== 409)
            throw error;
          return { status: "failed", error: error.message };
        }
      try {
        await sendDeliveryMessage(
          { cancellationNoticeId: id },
          attemptId,
          "whatsapp",
          row.recipient,
          (metadata) => sendTextMessage(row.recipient!, row.content, metadata),
        );
        return { status: "sent", error: null };
      } catch (failure) {
        const history = await tx.ticketDeliveryMessage.findMany({
          where: { cancellationNoticeId: id, dispatchAttemptId: attemptId },
        });
        const attempt = deliveryAttemptOutcome(history);
        console.error(
          "Original cancellation notice outcome unconfirmed:",
          id,
          failure,
        );
        return {
          status: attempt?.status === "failed" ? "failed" : "unknown",
          error:
            failure instanceof YeboLinkSendError
              ? failure.message
              : "The original notice outcome could not be confirmed. Inspect its saved message proof; it will not automatically be sent again.",
        };
      }
    },
    { timeout: 60000 },
  );
  const record = async () => {
    await lockCancellationNotice(prisma, id);
    await prisma.ticketCancellationNotice.updateMany({
      where: { id, attemptId, status: "sending" },
      data: {
        ...outcome,
        ...(outcome.status === "sent" ? { sentAt: new Date() } : {}),
      },
    });
    if (finalize) await finalize();
    return prisma.ticketCancellationNotice.findUniqueOrThrow({ where: { id } });
  };
  return staffAdminScope.transaction(record);
}

/** Financial completion/recovery dispatches only never-started work. */
export async function dispatchCancellationNotice(id: string) {
  const claim = await claimCancellationNotice(id);
  return claim.attemptId
    ? dispatchClaimedCancellationNotice(id, claim.attemptId)
    : prisma.ticketCancellationNotice.findUniqueOrThrow({ where: { id } });
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
