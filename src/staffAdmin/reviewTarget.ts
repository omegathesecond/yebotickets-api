import {
  commissionChangeEvidence,
  COMMISSION_POLICY,
} from "../services/platform-settings.service";
import {
  organizerDeletionEvidence,
  assertOrganizerDeletion,
} from "../services/organizer-admin.service";
import { profileChanges } from "../services/auth.service";
import { toOrganizerProfile } from "../interfaces/user.interface";
import { operationInput } from "./inputs";
import { validateParams, hashIntent } from "@omevision/product-admin-boundary";
import prisma from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { operations } from "./operations";
import { ticketRefundTerms } from "../services/ticket-refund-terms";
import { cancellationManifest } from "./cancellation";
import { getCheckInDetails } from "../services/ticket.service";
import {
  purchaseEvidence,
  purchaseSnapshot,
  purchaseView,
  purchaseRecoveryReceipt,
} from "./purchaseRecovery";
import { sumTicketRevenue } from "../services/settlement.service";
import { CURRENCY } from "../config/platform";
import { validateOperationInput } from "./inputs";
import { deliveryMessageView } from "../services/delivery-message.service";
import {
  deliveryReviewEvidence,
  assertDeliveryReview,
  lockOrderDelivery,
} from "../services/delivery-state.service";
import {
  lockCancellationNotice,
  noticeReviewEvidence,
  assertNoticeReview,
} from "../services/cancellation-notice-state.service";
import { deliveryRetries, noticeRetries } from "./deliveryRetries";
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
  return (
    "yebotickets:" +
    op.target.model +
    ":" +
    parameters[op.target.field] +
    (["admin_retry_delivery", "admin_retry_cancellation_notice"].includes(name)
      ? ":" + parameters.generationId
      : "")
  );
};
export async function review(
  name: string,
  parameters: Record<string, any>,
  lock = false,
) {
  const op = checked(name, parameters);
  if (name === "admin_update_platform_settings") {
    const settings = await commissionChangeEvidence(
      parameters.id,
      parameters.feePercent,
      lock,
    );
    return {
      version: hashIntent({ name, parameters, settings }),
      workspace: {
        id: settings.id,
        name: "Platform commission",
        currentCommissionPercent: settings.feePercent,
        requestedCommissionPercent: parameters.feePercent,
        currency: CURRENCY,
        policy: COMMISSION_POLICY,
      },
    };
  }

  if (name === "admin_retry_cancellation_notice") {
    const evidence = await noticeReviewEvidence(parameters.id, lock);
    const policy = assertNoticeReview(
      evidence,
      parameters.acknowledgeDuplicateRisk === true,
      parameters.generationId,
    );
    return {
      version: hashIntent({ name, parameters, evidence }),
      workspace: {
        id: evidence.order.id,
        name: evidence.order.eventTitle,
        ticketCode: evidence.order.ticketCode,
        previousAttemptId: evidence.order.attemptId,
        previousDeliveryStatus: evidence.order.status,
        acknowledgeDuplicateRisk: parameters.acknowledgeDuplicateRisk === true,
        duplicateRisk: policy.duplicateRisk,
        policy: policy.reason,
        note: "Retry only this immutable cancellation notice and original recipient. No money or new tickets. Message acceptance is not customer receipt.",
      },
    };
  }
  if (name === "admin_retry_delivery") {
    const evidence = await deliveryReviewEvidence(parameters.id, lock);
    const policy = assertDeliveryReview(
      evidence,
      parameters.acknowledgeDuplicateRisk === true,
      parameters.generationId,
    );
    return {
      version: hashIntent({ name, parameters, evidence }),
      workspace: {
        id: evidence.order.id,
        name: evidence.tickets[0].event.title,
        buyerName: evidence.tickets[0].user?.name,
        event: evidence.tickets[0].event.title,
        previousAttemptId: evidence.order.attemptId,
        previousDeliveryStatus: evidence.order.status,
        acknowledgeDuplicateRisk: parameters.acknowledgeDuplicateRisk === true,
        duplicateRisk: policy.duplicateRisk,
        policy: policy.reason,
      },
    };
  }
  if (
    ["admin_check_delivery_retry", "admin_check_notice_retry"].includes(name)
  ) {
    const original = await (
      name === "admin_check_delivery_retry" ? deliveryRetries : noticeRetries
    ).view(parameters.id);
    return {
      version: hashIntent({
        name,
        parameters,
        id: original.id,
        attempt: original.dispatchAttemptId,
      }),
      workspace: {
        id: original.id,
        name: "Original approved message retry",
        dispatchAttemptId: original.dispatchAttemptId,
        status: original.status,
        policy: original.note,
      },
    };
  }
  if (name === "admin_check_delivery_message") {
    let message = await prisma.ticketDeliveryMessage.findUnique({
      where: { id: parameters.id },
    });
    if (!message) throw fail("Original message attempt was not found", 404);
    if (lock) {
      if (message.deliveryOrderId)
        await lockOrderDelivery(prisma, message.deliveryOrderId);
      else if (message.cancellationNoticeId)
        await lockCancellationNotice(prisma, message.cancellationNoticeId);
      else throw fail("Original message has no owning work identity", 409);
      await prisma.$queryRaw`SELECT id FROM "TicketDeliveryMessage" WHERE id=${parameters.id} FOR UPDATE`;
      message = await prisma.ticketDeliveryMessage.findUniqueOrThrow({
        where: { id: parameters.id },
      });
    }
    if (!message.messageId)
      throw fail(
        "This attempt has no confirmed message identity. Do not assume it was not sent.",
        409,
      );
    return {
      version: hashIntent({ name, parameters, message }),
      workspace: {
        name: "Original ticket message",
        ...deliveryMessageView(message),
        policy:
          "Read only the exact original YeboLink receipt. No message, retry or channel change is sent.",
      },
    };
  }
  if (name === "admin_recover_purchase") {
    const evidence = await purchaseEvidence(parameters.id, lock);
    const source = purchaseView(evidence);
    return {
      version: hashIntent({
        name,
        parameters,
        snapshot: purchaseSnapshot(evidence),
      }),
      workspace: {
        id: source.id,
        name: source.buyerName ?? source.id,
        eventNames: source.eventNames,
        status: source.status,
        originalTicketCount: source.originalTicketCount,
        recordedAmount: source.recordedAmount,
        currency: source.currency,
        chargeId: source.chargeId,
        originalAttemptRef: source.originalAttemptRef,
        policy:
          "Recover only this saved purchase. Never create another charge or allocate new seats. The existing service can issue confirmed paid tickets, deliver the tracked order, or refund a confirmed payment for a cancelled event. Unknown refunds and deliveries retain their original safeguards.",
      },
    };
  }
  if (
    [
      "admin_check_purchase_recovery",
      "admin_continue_purchase_recovery",
    ].includes(name)
  ) {
    const record = await purchaseRecoveryReceipt(parameters.id);
    return {
      version: hashIntent({ name, parameters, id: record.id }),
      workspace: {
        id: record.id,
        name: record.source.buyerName ?? record.source.id,
        purchase: record.source.id,
        status: record.source.status,
        policy:
          name === "admin_check_purchase_recovery"
            ? "Read original source/payment proof. No charge, ticket message or refund is dispatched by this check."
            : "Queue only the original approved purchase recovery. It cannot create a charge or allocate new seats; original refund and delivery holds remain authoritative.",
      },
    };
  }
  if (
    ["admin_continue_cancellation", "admin_check_cancellation"].includes(name)
  ) {
    const manifest = await cancellationManifest(parameters.id);
    return {
      version: hashIntent({ name, parameters, manifest }),
      workspace: {
        id: manifest.operationId,
        name: manifest.eventTitle,
        eventId: manifest.eventId,
        ticketCount: manifest.members.length,
        policy:
          name === "admin_check_cancellation"
            ? "Read only original refund proof. Never start a refund or send a notification."
            : "Continue only never-started tickets from the original frozen approval. Existing unknown or failed attempts are never replaced. Changed tickets require a fresh exact refund review.",
      },
    };
  }
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
  if (name === "admin_delete_organizer") {
    const evidence = await organizerDeletionEvidence(parameters.id, lock);
    assertOrganizerDeletion(evidence);
    if (parameters.confirmName !== evidence.account.name)
      throw fail(
        "Type the organiser's full name exactly to confirm permanent deletion",
        400,
      );
    return {
      version: hashIntent({ name, parameters, evidence }),
      workspace: {
        id: evidence.account.id,
        name: evidence.account.name,
        companyName: evidence.account.companyName,
        dependencies: evidence.dependencies,
        policy: evidence.reason,
      },
    };
  }
  const table = op.target && tables[op.target.model];
  if (!table) throw fail("This operation has no editable target");
  await validateOperationInput(name, parameters);
  let admissionEvent: any;
  if (name === "admin_check_in") {
    const ticket = await prisma.ticket.findUniqueOrThrow({
      where: { id: parameters.id },
      select: { eventId: true },
    });
    // Same Event -> Ticket order as the existing scanner claim and cancellation.
    const events = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id,title,"isCancelled" FROM "Event" WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
      ticket.eventId,
    );
    if (!events.length) throw fail("The admission event was not found", 404);
    admissionEvent = events[0];
  }
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "${table}" WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    parameters[op.target.field],
  );
  if (!rows.length) throw fail("The product record was not found", 404);
  if (op.target.model === "user" && rows[0].role !== "organizer")
    throw fail("Choose an organiser account", 404);
  if (
    name === "admin_organizer_access" &&
    rows[0].isActive === parameters.isActive
  )
    throw fail("Choose a different account access state", 409);
  const profileContext =
    name === "admin_update_organizer_profile"
      ? {
          current: {
            name: rows[0].name,
            email: rows[0].email,
            organizerProfile: toOrganizerProfile(rows[0]),
          },
          changes: await profileChanges(
            rows[0].role,
            operationInput(parameters),
          ),
        }
      : undefined;
  let cancellationContext: any;
  if (name === "admin_cancel_event") {
    const prior = await prisma.$queryRawUnsafe<any[]>(
      'SELECT "operationId" FROM staff_admin_event_cancellations WHERE "eventId"=$1',
      parameters.id,
    );
    if (prior.length)
      throw fail(
        "This event already has an original cancellation. Open it to continue or check proof.",
        409,
      );
    const members = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "Ticket" WHERE "eventId"=$1 AND status IN ('sold','reserved') ORDER BY id${lock ? " FOR UPDATE" : ""}`,
      parameters.id,
    );
    const holds = await prisma.ticketRefundLock.findMany({
      where: {
        OR: [
          { ticketId: { in: members.map((row) => row.id) } },
          {
            chargeId: {
              in: members.map((row) => row.paymentRef).filter(Boolean),
            },
          },
        ],
      },
      orderBy: { chargeId: "asc" },
    });
    const refundableMembers: Array<{ amountPaid: number | null }> = [];
    let awaitingPayment = 0;
    for (const member of members) {
      if (
        member.status === "reserved" &&
        member.paymentStatus !== "SUCCEEDED"
      ) {
        awaitingPayment++;
        continue;
      }
      ticketRefundTerms({ ...member, event: { isCancelled: true } });
      refundableMembers.push(member);
    }
    cancellationContext = {
      members,
      holds,
      recordedRefundAmount: sumTicketRevenue(refundableMembers),
      awaitingPayment,
    };
  }
  let admissionContext: any;
  if (name === "admin_check_in") {
    if (rows[0].eventId !== admissionEvent.id)
      throw fail("The ticket event changed; prepare a fresh request", 409);
    admissionContext = await getCheckInDetails(
      parameters.id,
      admissionEvent.id,
      undefined,
    );
    if (!admissionContext.canCheckIn) throw fail(admissionContext.message, 409);
  }
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
      admissionEvent,
      admissionContext,
      cancellationContext,
      profileContext,
    }),
    workspace: {
      id: rows[0].id,
      name: rows[0].name ?? rows[0].title ?? op.title,
      ...(name === "admin_organizer_access"
        ? {
            currentAccess: rows[0].isActive ? "Active" : "Suspended",
            requestedAccess: parameters.isActive ? "Active" : "Suspended",
            policy:
              "Revoke all existing sessions and codes. Reactivation requires a fresh sign-in. Keep all events, tickets, payments and history.",
          }
        : {}),
      ...(profileContext
        ? {
            currentProfile: profileContext.current,
            changedFields: profileContext.changes,
            policy:
              "Change only these selected organiser profile fields. Phone login, password, roles, verification and payout decisions are separate. Changing the email invalidates outstanding reset codes.",
          }
        : {}),
      ...(cancellationContext
        ? {
            ticketCount: cancellationContext.members.length,
            recordedRefundAmount: cancellationContext.recordedRefundAmount,
            currency: CURRENCY,
            awaitingPayment: cancellationContext.awaitingPayment,
            originalRefundsHeld: cancellationContext.holds.length,
            tickets: cancellationContext.members.map((row: any) => ({
              ticketCode: row.uniqueCode,
              status: row.status,
              paymentStatus: row.paymentStatus,
              recordedAmount: row.amountPaid,
              isCheckedIn: row.isCheckedIn,
            })),
            policy:
              "Stop event sales and admission, freeze this exact ticket set and use original per-ticket refund attempts. Pending payments and existing holds stay unresolved until authoritative proof; notices are separate outcomes.",
          }
        : {}),
      ...(admissionContext
        ? {
            ticketCode: rows[0].uniqueCode,
            event: admissionEvent.title,
            holder: admissionContext.ticket.name,
            isCheckedIn: rows[0].isCheckedIn,
            policy:
              "Admit this exact ticket once. The original operator receipt, corporate audit and CEO operation commit together.",
          }
        : {}),
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
