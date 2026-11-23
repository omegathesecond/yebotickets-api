import { Router, Request } from "express";
import {
  createStaffAdminBoundary,
  matchOperation,
} from "@omevision/product-admin-boundary";
import prisma, { staffAdminScope } from "../config/prisma";
import { ApiError } from "../middleware/error.middleware";
import { getDashboardMetrics } from "../services/dashboard.service";
import {
  listOrganizers,
  getOrganizerAccount,
  setOrganizerVerification,
} from "../services/organizer-admin.service";
import {
  getEvents,
  getEventById,
  adminUnpublishEvent,
  createEvent,
  updateEvent,
  deleteEvent,
} from "../services/event.service";
import {
  getEventDetailsForOrganizer,
  getEventTickets,
  getEventPurchases,
} from "../services/organizer-event.service";
import * as payouts from "../services/payout.service";
import {
  listRefundRecovery,
  getTicketTypes,
  createTicketType,
  updateTicketType,
  deleteTicketType,
  generateTickets,
  refundTicket,
  reconcileRefundAttempt,
  getCheckInDetails,
  confirmCheckIn,
} from "../services/ticket.service";
import {
  startCorporateCancellation,
  cancellationView,
  checkCorporateCancellation,
  recoverCorporateCancellations,
} from "./cancellation";
import {
  purchaseEvidence,
  purchaseView,
  listPurchases,
  recoverCorporatePurchase,
  purchaseRecoveryReceipt,
  checkCorporatePurchase,
  resumeCorporatePurchase,
} from "./purchaseRecovery";
import {
  listDeliveryRecords,
  deliveryRecord,
  listDeliveryMessages,
  deliveryMessageRecord,
} from "./deliveryRecords";
import { checkDeliveryMessage } from "../services/delivery-message.service";
import {
  retryCorporateDelivery,
  deliveryRetryView,
  checkOriginalDeliveryRetry,
  reconcileDeliveryRetryForMessage,
} from "./deliveryRetries";
import { verifyCorporateWorkload } from "./workloadIdentity";
import { operations } from "./operations";
import workspace from "./workspace";
import { operationInput, validateOperationInput } from "./inputs";

import { staffOperationStore as store } from "./receipts";
import { checked, targetKey, review } from "./reviewTarget";
import { recordStaffOperation, verifiedStaffOperation } from "./audit";
const fail = (message: string, status = 400) => new ApiError(message, status);
const page = (parameters: Record<string, any>) => ({
  page: parameters.page ?? 1,
  limit: parameters.limit ?? 20,
});
const recordsPage = (records: any[], parameters: Record<string, any>) => {
  const { page: p, limit } = page(parameters);
  return {
    records: records.slice((p - 1) * limit, p * limit),
    total: records.length,
  };
};
function queryFields(op: any, query: Record<string, any>) {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      op.properties[key]?.type === "integer" &&
      typeof value === "string" &&
      /^\d+$/.test(value)
        ? Number(value)
        : value,
    ]),
  );
}

/** Native corporate actors never occupy req.user or a product admin session. */
export function createCorporateAdminRouter(
  verify: typeof verifyCorporateWorkload = verifyCorporateWorkload,
) {
  const router = Router();
  router.use(
    createStaffAdminBoundary({
      product: "yebotickets",
      verify,
      store,
      context: (actor, run) => staffAdminScope.context(actor, run),
      transaction: (run) => staffAdminScope.transaction(run),
      targetKey: (req) =>
        targetKey(
          req.res!.locals.native.name,
          req.res!.locals.native.parameters,
        ),
      reviewTarget: async (req, lock) => {
        const target = await review(
          req.res!.locals.native.name,
          req.res!.locals.native.parameters,
          lock,
        );
        req.res!.locals.nativeTargetVersion = target.version;
        return target;
      },
      external: (req) => req.res!.locals.native?.operation.external === true,
      async onVerified(req) {
        const matched = matchOperation(operations, req.method, req.path);
        if (!matched && !["/capabilities", "/review-target"].includes(req.path))
          throw fail("Unknown Tickets administration route", 404);
        if (matched) {
          const parameters = {
            ...(req.method === "GET"
              ? queryFields(matched.operation, req.query)
              : (req.body ?? {})),
            ...matched.parameters,
          };
          checked(matched.name, parameters);
          await validateOperationInput(matched.name, parameters);
          req.res!.locals.native = { ...matched, parameters };
        }
      },
    }),
  );
  router.get("/capabilities", (_req, res) =>
    res.json({
      success: true,
      data: {
        version: 1,
        product: "yebotickets",
        operations: Object.fromEntries(
          Object.entries(operations).map(([name, { target, ...op }]) => [
            name,
            op,
          ]),
        ),
        workspace,
      },
    }),
  );
  router.get("/review-target", async (req, res, next) => {
    try {
      if (
        typeof req.query.operation !== "string" ||
        typeof req.query.parameters !== "string"
      )
        throw fail("Choose a reviewed operation");
      const parameters = JSON.parse(req.query.parameters);
      res.json({
        success: true,
        data: await review(req.query.operation, parameters),
      });
    } catch (error) {
      next(error);
    }
  });
  router.use(async (req, res, next) => {
    try {
      const { name, parameters: p } = res.locals.native,
        actor = staffAdminScope.actor();
      if (!actor)
        throw fail("A verified corporate staff actor is required", 401);
      let data: any;
      switch (name) {
        case "admin_stats":
          data = await getDashboardMetrics();
          break;
        case "admin_organizers":
          data = await listOrganizers({ ...page(p), search: p.search });
          break;
        case "admin_choose_organizers":
        case "admin_settlement_organizers":
          data = await listOrganizers({
            ...page(p),
            search: p.search,
            choices: true,
          });
          break;
        case "admin_organizer":
          data = await getOrganizerAccount(p.id);
          break;
        case "admin_organizer_verification":
          data = await setOrganizerVerification(p.id, p.isVerified);
          break;
        case "admin_organizer_statement": {
          const account = await getOrganizerAccount(p.id);
          data = {
            id: account.id,
            name: account.name,
            payoutApprovalStatus: account.payoutApprovalStatus,
            ...(await payouts.getOrganizerBalance(p.id)),
          };
          break;
        }
        case "admin_organizer_destination":
          data = await payouts.getPayoutMethod(p.id);
          break;
        case "admin_organizer_payout_approval":
          data = await payouts.setPayoutApprovalStatus(
            p.id,
            p.payoutApprovalStatus,
            { corporateStaffId: actor.id },
          );
          break;
        case "admin_events":
        case "admin_ticket_events": {
          const result = await getEvents({
            ...page(p),
            search: p.search,
            showUnpublished: "true",
            showCancelled: "true",
            includePast: "true",
          });
          data = {
            records:
              name === "admin_ticket_events"
                ? result.data.map(
                    ({
                      id,
                      title,
                      startDate,
                      endDate,
                      isCancelled,
                      isPublished,
                    }) => ({
                      id,
                      title,
                      startDate,
                      endDate,
                      isCancelled,
                      isPublished,
                    }),
                  )
                : result.data,
            total: result.total,
          };
          break;
        }
        case "admin_event":
          data = await getEventById(p.id);
          break;
        case "admin_create_event":
          data = await createEvent(operationInput(p) as any, p.organizerId);
          break;
        case "admin_update_event":
          data = await updateEvent(p.id, operationInput(p), undefined);
          break;
        case "admin_delete_event":
          data = await deleteEvent(p.id, undefined);
          break;
        case "admin_event_inventory":
          data = { records: await getTicketTypes(p.eventId) };
          break;
        case "admin_ticket_type": {
          const tier = await prisma.ticketType.findUniqueOrThrow({
            where: { id: p.ticketTypeId },
          });
          data = (await getTicketTypes(tier.eventId)).find(
            (record) => record.id === p.ticketTypeId,
          );
          if (!data) throw fail("Ticket tier was not found", 404);
          break;
        }
        case "admin_create_ticket_type":
          data = await createTicketType(
            operationInput(p),
            p.eventId,
            undefined,
          );
          break;
        case "admin_update_ticket_type":
          data = await updateTicketType(p.id, operationInput(p), undefined);
          break;
        case "admin_delete_ticket_type":
          data = await deleteTicketType(p.id, undefined);
          break;
        case "admin_generate_inventory":
          data = await generateTickets(p.id, p.quantity, undefined);
          break;
        case "admin_ticket_event": {
          const event = await getEventById(p.id);
          const { id, title, startDate, endDate, isCancelled, isPublished } =
            event;
          data = { id, title, startDate, endDate, isCancelled, isPublished };
          break;
        }
        case "admin_unpublish_event":
          data = await adminUnpublishEvent(p.id);
          break;
        case "admin_event_stats":
          data = await getEventDetailsForOrganizer(p.id, undefined);
          break;
        case "admin_event_tickets": {
          const result = await getEventTickets(
            p.id,
            undefined,
            String(page(p).page),
            String(page(p).limit),
          );
          data = { records: result.tickets, total: result.total };
          break;
        }
        case "admin_event_purchases": {
          const result = await getEventPurchases(
            p.id,
            undefined,
            String(page(p).page),
            String(page(p).limit),
          );
          data = { records: result.purchases, total: result.total };
          break;
        }
        case "admin_admission_preview":
        case "admin_check_in": {
          const ticket = await prisma.ticket.findUniqueOrThrow({
            where: { id: p.id },
            select: { eventId: true },
          });
          if (name === "admin_admission_preview") {
            const details = await getCheckInDetails(
              p.id,
              ticket.eventId,
              undefined,
            );
            data = {
              ...details.ticket,
              canCheckIn: details.canCheckIn,
              message: details.message,
            };
          } else {
            data = await confirmCheckIn(
              p.id,
              ticket.eventId,
              undefined,
              verifiedStaffOperation(req).id,
            );
          }
          break;
        }
        case "admin_cancel_event": {
          const outcome = await startCorporateCancellation(
            verifiedStaffOperation(req),
          );
          return res.status(outcome.success ? 200 : 502).json(outcome);
        }
        case "admin_cancellations": {
          const { page: pg, limit } = page(p);
          const [records, counts] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
              'SELECT c."operationId" AS id,c."eventTitle",c."createdAt",jsonb_array_length(c.members) AS "ticketCount",o.state AS "operationState" FROM staff_admin_event_cancellations c JOIN staff_admin_operations o ON o.id=c."operationId" ORDER BY c."createdAt" DESC,c."operationId" LIMIT $1 OFFSET $2',
              limit,
              (pg - 1) * limit,
            ),
            prisma.$queryRawUnsafe<any[]>(
              "SELECT COUNT(*)::integer AS total FROM staff_admin_event_cancellations",
            ),
          ]);
          data = { records, total: counts[0].total };
          break;
        }
        case "admin_cancellation": {
          const { records, ...summary } = await cancellationView(p.id);
          data = summary;
          break;
        }
        case "admin_cancellation_tickets": {
          const result = await cancellationView(p.id);
          data = recordsPage(
            result.records.map((record) => ({
              ...record,
              id: record.ticketId,
            })),
            p,
          );
          break;
        }
        case "admin_continue_cancellation": {
          const original = await cancellationView(p.id);
          data = {
            status: "ORIGINAL_WORK_QUEUED",
            originalOperationId: p.id,
            originalOperationState: original.operationState,
            remaining: original.remaining,
            note: "Only never-started original approved tickets are queued. Unknown and failed refund attempts are never dispatched again. This receipt does not claim a completed cancellation or payment.",
          };
          // The real response is sent by the boundary only after this local
          // request/audit/receipt transaction commits. The durable original
          // manifest is also picked up by the existing recovery scheduler.
          const queueOperationId = verifiedStaffOperation(req).id;
          res.once("finish", () => {
            (async () => {
              const queued = await store.get(queueOperationId);
              if (queued?.state === "completed")
                await recoverCorporateCancellations(p.id);
            })().catch((error) =>
              console.error(
                "Original event cancellation recovery failed:",
                error,
              ),
            );
          });
          break;
        }
        case "admin_check_cancellation": {
          const outcome = await checkCorporateCancellation(p.id);
          data = {
            ...outcome.data,
            originalOperationId: p.id,
            originalOperationState: outcome.operation.state,
          };
          break;
        }
        case "admin_payouts":
          data = recordsPage(await payouts.listPayoutRequests(p.status), p);
          break;
        case "admin_payout":
          data = await prisma.payoutRequest.findUniqueOrThrow({
            where: { id: p.id },
            include: {
              organizer: {
                select: { id: true, name: true, companyName: true },
              },
            },
          });
          break;
        case "admin_approve_payout":
        case "admin_reject_payout":
        case "admin_record_paid_payout":
          data = await payouts.updatePayoutRequestStatus(
            p.id,
            (
              {
                admin_approve_payout: "approved",
                admin_reject_payout: "rejected",
                admin_record_paid_payout: "paid",
              } as const
            )[
              name as
                | "admin_approve_payout"
                | "admin_reject_payout"
                | "admin_record_paid_payout"
            ],
            { corporateStaffId: actor.id },
            { adminNote: p.reason, reference: p.reference },
          );
          break;
        case "admin_ticket_record":
          data = await prisma.ticket.findUniqueOrThrow({
            where: { id: p.id },
            select: {
              id: true,
              uniqueCode: true,
              status: true,
              isCheckedIn: true,
              eventId: true,
              event: { select: { title: true, isCancelled: true } },
              ticketType: { select: { name: true } },
              user: { select: { name: true } },
              amountPaid: true,
              paymentRef: true,
              paymentStatus: true,
              refundAttemptId: true,
              refundGatewayRequestId: true,
              refundRef: true,
              refundedAt: true,
              refundRequestedAt: true,
              refundRequestReason: true,
            },
          });
          break;
        case "admin_refund_ticket": {
          const context = verifiedStaffOperation(req);
          const outcome = await refundTicket(
            p.id,
            undefined,
            p.reason,
            context,
          );
          const receipt = await store.get(context.id);
          if (
            !receipt ||
            !["completed", "failed"].includes(receipt.state ?? "") ||
            typeof receipt.responseStatus !== "number" ||
            !receipt.responseBody
          )
            throw fail(
              "The original refund is unresolved; check its original proof before another request",
              502,
            );
          return res.status(receipt.responseStatus).json({
            ...receipt.responseBody,
            data: {
              ...receipt.responseBody.data,
              holderNotification: {
                notified: outcome.notified,
                error: outcome.notifyError ?? null,
              },
            },
          });
        }
        case "admin_check_refund": {
          const claim = await prisma.ticketRefundLock.findUnique({
            where: { attemptId: p.attemptId },
          });
          if (claim) {
            if (claim.ticketId !== p.id)
              throw fail(
                "Original refund does not belong to the selected ticket",
                409,
              );
            data = await reconcileRefundAttempt(
              claim.chargeId,
              claim.attemptId,
            );
          } else {
            const ticket = await prisma.ticket.findUniqueOrThrow({
              where: { id: p.id },
            });
            if (
              ticket.refundAttemptId !== p.attemptId ||
              ticket.paymentStatus !== "REFUNDED" ||
              ticket.status !== "cancelled"
            )
              throw fail("Original refund proof was not found", 409);
            data = {
              status: "FINALIZED",
              ticketId: ticket.id,
              refundAttemptId: p.attemptId,
              refundRef: ticket.refundRef,
              note: "The original verified completion is already stored. No new refund was sent.",
            };
          }
          const originals = await prisma.$queryRawUnsafe<any[]>(
            `SELECT a.id,o.state FROM staff_admin_audit a JOIN staff_admin_operations o ON o.id=a.id WHERE a.id=$1::uuid AND a.operation='admin_refund_ticket' AND a.parameters->>'id'=$2`,
            p.attemptId,
            p.id,
          );
          if (claim?.corporateOperationId && !originals.length)
            throw fail(
              "The original corporate refund receipt was not found",
              409,
            );
          data = {
            ...data,
            originalOperationId: originals[0]?.id ?? null,
            originalOperationState: originals[0]?.state ?? null,
            notificationNote:
              "Checking original refund proof does not send a holder notification.",
          };
          break;
        }
        case "admin_refunds": {
          const { page: pg, limit } = page(p);
          const [records, count] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
              `SELECT a.id,a."staffName",a.parameters->>'id' AS "ticketId",a.parameters->'reviewedEffect'->>'uniqueCode' AS "ticketCode",a.parameters->'reviewedEffect'->>'amount' AS amount,a.parameters->'reviewedEffect'->>'currency' AS currency,a.parameters->>'reason' AS reason,o.state AS "operationState",o."responseBody"->'data'->>'status' AS "refundStatus",o."responseBody"->>'error' AS error,a."createdAt" FROM staff_admin_audit a JOIN staff_admin_operations o ON o.id=a.id WHERE a.operation='admin_refund_ticket' ORDER BY a."createdAt" DESC,a.id LIMIT $1 OFFSET $2`,
              limit,
              (pg - 1) * limit,
            ),
            prisma.$queryRawUnsafe<any[]>(
              `SELECT COUNT(*)::integer AS total FROM staff_admin_audit WHERE operation='admin_refund_ticket'`,
            ),
          ]);
          data = { records, total: count[0].total };
          break;
        }
        case "admin_refund_record": {
          const audit = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id,parameters,"staffName","createdAt" FROM staff_admin_audit WHERE id=$1::uuid AND operation='admin_refund_ticket'`,
            p.id,
          );
          if (!audit.length)
            throw fail("Original corporate refund was not found", 404);
          const receipt = await store.get(p.id);
          if (!receipt)
            throw fail("Original corporate receipt was not found", 404);
          data = {
            id: p.id,
            ...audit[0],
            operationState: receipt.state,
            responseStatus: receipt.responseStatus,
            receipt: receipt.responseBody,
          };
          break;
        }
        case "admin_refund_recovery":
          data = {
            records: (await listRefundRecovery()).map(
              ({ action, ...record }) => ({ ...record, id: record.ticketId }),
            ),
          };
          break;
        case "admin_purchases":
          data = await listPurchases(p);
          break;
        case "admin_purchase": {
          const { tickets, ...summary } = purchaseView(
            await purchaseEvidence(p.id),
          );
          data = summary;
          break;
        }
        case "admin_purchase_tickets":
          data = recordsPage(
            purchaseView(await purchaseEvidence(p.id)).tickets,
            p,
          );
          break;
        case "admin_recover_purchase":
          return res.json(
            await recoverCorporatePurchase(verifiedStaffOperation(req)),
          );
        case "admin_purchase_recoveries": {
          const { page: pg, limit } = page(p);
          const [records, count] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
              `SELECT a.id,a."staffName",a."createdAt",a.parameters->>'id' AS "purchaseId",o.state AS "operationState" FROM staff_admin_audit a JOIN staff_admin_operations o ON o.id=a.id WHERE a.operation=$1 ORDER BY a."createdAt" DESC,a.id LIMIT $2 OFFSET $3`,
              "admin_recover_purchase",
              limit,
              (pg - 1) * limit,
            ),
            prisma.$queryRawUnsafe<any[]>(
              "SELECT COUNT(*)::integer AS total FROM staff_admin_audit WHERE operation=$1",
              "admin_recover_purchase",
            ),
          ]);
          data = { records, total: count[0].total };
          break;
        }
        case "admin_purchase_recovery":
          data = await purchaseRecoveryReceipt(p.id);
          break;
        case "admin_check_purchase_recovery":
          data = await checkCorporatePurchase(p.id);
          break;
        case "admin_continue_purchase_recovery": {
          const original = await purchaseRecoveryReceipt(p.id),
            queuedId = verifiedStaffOperation(req).id;
          data = {
            status: "ORIGINAL_RECOVERY_QUEUED",
            originalOperationId: p.id,
            originalOperationState: original.operationState,
            note: "Queued is not a confirmed payment, ticket or delivery outcome.",
          };
          res.once("finish", () => {
            (async () => {
              if ((await store.get(queuedId))?.state === "completed")
                await resumeCorporatePurchase(p.id);
            })().catch((error) =>
              console.error("Original purchase recovery failed:", error),
            );
          });
          break;
        }
        case "admin_deliveries":
          data = await listDeliveryRecords(p);
          break;
        case "admin_delivery":
          data = await deliveryRecord(p.id);
          break;
        case "admin_delivery_messages":
          data = await listDeliveryMessages(p);
          break;
        case "admin_delivery_message":
          data = await deliveryMessageRecord(p.id);
          break;
        case "admin_check_delivery_message":
          data = {
            ...(await checkDeliveryMessage(p.id)),
            ...(await reconcileDeliveryRetryForMessage(p.id)),
          };
          break;
        case "admin_retry_delivery": {
          const body = await retryCorporateDelivery(
            verifiedStaffOperation(req),
          );
          return res.status(body.success ? 200 : 502).json(body);
        }
        case "admin_delivery_retries": {
          const { page: pg, limit } = page(p);
          const [records, count] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
              `SELECT a.id,a."staffName",a."createdAt",a.parameters->>'id' AS "deliveryOrderId",a.parameters->'reviewedEffect'->>'dispatchAttemptId' AS "dispatchAttemptId",o.state AS "operationState" FROM staff_admin_audit a JOIN staff_admin_operations o ON o.id=a.id WHERE a.operation='admin_retry_delivery' ORDER BY a."createdAt" DESC,a.id LIMIT $1 OFFSET $2`,
              limit,
              (pg - 1) * limit,
            ),
            prisma.$queryRawUnsafe<any[]>(
              "SELECT COUNT(*)::integer AS total FROM staff_admin_audit WHERE operation='admin_retry_delivery'",
            ),
          ]);
          data = { records, total: count[0].total };
          break;
        }
        case "admin_delivery_retry":
          data = await deliveryRetryView(p.id);
          break;
        case "admin_check_delivery_retry":
          data = await checkOriginalDeliveryRetry(p.id);
          break;
        case "admin_operation_receipt":
          data = await store.get(p.operationId);
          if (!data)
            throw fail("Original corporate receipt was not found", 404);
          break;
        case "admin_activity": {
          const { page: pg, limit } = page(p);
          const [records, count] = await Promise.all([
            prisma.$queryRawUnsafe<any[]>(
              'SELECT * FROM staff_admin_audit ORDER BY "createdAt" DESC,id LIMIT $1 OFFSET $2',
              limit,
              (pg - 1) * limit,
            ),
            prisma.$queryRawUnsafe<any[]>(
              "SELECT COUNT(*)::integer AS total FROM staff_admin_audit",
            ),
          ]);
          data = { records, total: count[0].total };
          break;
        }
        default:
          throw fail("Unknown Tickets administration operation", 404);
      }
      if (req.method !== "GET")
        await recordStaffOperation(verifiedStaffOperation(req));
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  });
  router.use((error: any, _req: Request, res: any, _next: any) =>
    res
      .status(error.statusCode ?? error.status ?? 500)
      .json({ success: false, error: error.message }),
  );
  return router;
}
