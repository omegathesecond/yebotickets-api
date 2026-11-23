import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import {
  claimOrderDelivery,
  dispatchClaimedOrderDelivery,
} from "../services/ticket.service";
import {
  deliveryReviewEvidence,
  assertDeliveryReview,
  deliveryContentVersion,
} from "../services/delivery-state.service";
import {
  noticeReviewEvidence,
  assertNoticeReview,
  noticeContentVersion,
} from "../services/cancellation-notice-state.service";
import {
  claimCancellationNotice,
  dispatchClaimedCancellationNotice,
} from "../services/cancellation-notice.service";
import { createReviewedMessageRetry } from "./reviewedMessageRetry";

export const deliveryRetries = createReviewedMessageRetry({
  operation: "admin_retry_delivery",
  targetModel: "deliveryOrder",
  workField: "deliveryOrderId",
  getWork: (id) => prisma.ticketOrderDelivery.findUnique({ where: { id } }),
  evidence: deliveryReviewEvidence,
  assertReview: assertDeliveryReview,
  contentVersion: deliveryContentVersion,
  claim: (...args) => claimOrderDelivery(...args),
  dispatch: (...args) => dispatchClaimedOrderDelivery(...args),
});
export const noticeRetries = createReviewedMessageRetry({
  operation: "admin_retry_cancellation_notice",
  targetModel: "cancellationNotice",
  workField: "cancellationNoticeId",
  getWork: (id) =>
    prisma.ticketCancellationNotice.findUnique({ where: { id } }),
  evidence: noticeReviewEvidence,
  assertReview: assertNoticeReview,
  contentVersion: noticeContentVersion,
  claim: (...args) => claimCancellationNotice(...args),
  dispatch: (...args) => dispatchClaimedCancellationNotice(...args),
});
export async function reconcileMessageRetryForMessage(id: string) {
  const message = await prisma.ticketDeliveryMessage.findUnique({
    where: { id },
  });
  if (!message) throw new ApiError("The original message was not found", 404);
  return (message.deliveryOrderId ? deliveryRetries : noticeRetries).reconcile(
    message,
  );
}
