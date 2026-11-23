import { Router, Request } from "express";
import {
  createStaffAdminBoundary,
  createPostgresOperationStore,
  matchOperation,
  validateParams,
  hashIntent,
  redact,
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
} from "../services/ticket.service";
import { verifyCorporateWorkload } from "./workloadIdentity";
import { operations } from "./operations";
import workspace from "./workspace";
import { operationInput, validateOperationInput } from "./inputs";

const store = createPostgresOperationStore(async (query, values) => ({
  rows: await prisma.$queryRawUnsafe<any[]>(query, ...values),
}));
const tables: Record<string, string> = {
  user: "User",
  event: "Event",
  payoutRequest: "PayoutRequest",
  ticketType: "TicketType",
};
const fail = (message: string, status = 400) => new ApiError(message, status);
function checked(name: string, parameters: Record<string, any>) {
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
const targetKey = (name: string, parameters: Record<string, any>) => {
  const op = checked(name, parameters);
  if (!op.target) throw fail("Choose an operation that changes a record");
  return "yebotickets:" + op.target.model + ":" + parameters[op.target.field];
};
async function review(
  name: string,
  parameters: Record<string, any>,
  lock = false,
) {
  const op = checked(name, parameters),
    table = op.target && tables[op.target.model];
  if (!table) throw fail("This operation has no editable target");
  await validateOperationInput(name, parameters);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "${table}" WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    parameters[op.target.field],
  );
  if (!rows.length) throw fail("The product record was not found", 404);
  if (op.target.model === "user" && rows[0].role !== "organizer")
    throw fail("Choose an organiser account", 404);
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
    version: hashIntent({ name, parameters, rows, inventory, tiers }),
    workspace: {
      id: rows[0].id,
      name: rows[0].name ?? rows[0].title ?? op.title,
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
      reviewTarget: (req, lock) =>
        review(
          req.res!.locals.native.name,
          req.res!.locals.native.parameters,
          lock,
        ),
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
        case "admin_refund_recovery":
          data = { records: await listRefundRecovery() };
          break;
        case "admin_operation_receipt":
          data = await store.get(p.id);
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
        await prisma.$executeRawUnsafe(
          'INSERT INTO staff_admin_audit(id,"staffId","staffName","staffEmail",operation,"targetKey",parameters) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb)',
          req.get("Idempotency-Key"),
          actor.id,
          actor.name ?? null,
          actor.email ?? null,
          name,
          targetKey(name, p),
          JSON.stringify(redact(p)),
        );
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
