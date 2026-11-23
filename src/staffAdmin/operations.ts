const id = {
  type: "string",
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
};
const reason = { type: "string", minLength: 5, maxLength: 1000 };
const pagination = {
  page: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};
const search = { type: "string", maxLength: 200 };
const organizer = {
  ...id,
  title: "Organiser",
  "x-resource": {
    operation: "admin_choose_organizers",
    collection: "records",
    value: "id",
    label: "name",
    search: "search",
  },
};
const read = (
  title: string,
  path: string,
  area: string,
  properties: any = {},
  extra: any = {},
) => ({ title, path, area, method: "GET", properties, ...extra });
const change = (
  title: string,
  path: string,
  area: string,
  model: string,
  properties: any,
  required: string[],
) => ({
  title,
  path,
  area,
  method: "PATCH",
  properties: { id, reason, ...properties },
  required: ["id", "reason", ...required],
  target: { model, field: "id" },
});
const paged = { collection: "records", total: "total" };
export const operations: Record<string, any> = {
  admin_stats: read(
    "Platform overview",
    "/stats",
    "money",
    {},
    { accessAreas: ["events", "organizers", "tickets", "money"] },
  ),
  admin_organizers: read(
    "Organisers",
    "/organizers",
    "organizers",
    { search, ...pagination },
    paged,
  ),
  admin_choose_organizers: read(
    "Choose an organiser",
    "/choices/organizers",
    "organizers",
    { search, ...pagination },
    { ...paged, accessAreas: ["organizers", "events", "money"] },
  ),
  admin_organizer: read("Organiser details", "/organizers/:id", "organizers", {
    id,
  }),
  admin_settlement_organizers: read(
    "Organiser settlements",
    "/settlements",
    "money",
    { search, ...pagination },
    paged,
  ),
  admin_organizer_verification: change(
    "Set phone verification flag",
    "/organizers/:id/verification",
    "organizers",
    "user",
    { isVerified: { type: "boolean" } },
    ["isVerified"],
  ),
  admin_organizer_statement: read(
    "Original-payment settlement statement",
    "/organizers/:id/statement",
    "money",
    { id: organizer },
  ),
  admin_organizer_destination: read(
    "Organiser payout destination",
    "/organizers/:id/payout-method",
    "money",
    { id: organizer },
  ),
  admin_organizer_payout_approval: change(
    "Review organiser payout access",
    "/organizers/:id/payout-approval",
    "money",
    "user",
    {
      payoutApprovalStatus: {
        type: "string",
        enum: ["unreviewed", "approved", "rejected"],
      },
    },
    ["payoutApprovalStatus"],
  ),
  admin_events: read(
    "Events",
    "/events",
    "events",
    { search, ...pagination },
    paged,
  ),
  admin_event: read("Event details", "/events/:id", "events", { id }),
  admin_ticket_events: read(
    "Choose an event for ticket records",
    "/ticket-events",
    "tickets",
    { search, ...pagination },
    { ...paged, accessAreas: ["tickets", "money"] },
  ),
  admin_ticket_event: read(
    "Selected ticket event",
    "/ticket-events/:id",
    "tickets",
    { id },
    { accessAreas: ["tickets", "money"] },
  ),
  admin_unpublish_event: change(
    "Unpublish this event",
    "/events/:id/unpublish",
    "events",
    "event",
    {},
    [],
  ),
  admin_event_stats: read(
    "Event paid allocations and inventory",
    "/events/:id/stats",
    "money",
    { id },
  ),
  admin_event_tickets: read(
    "Event tickets",
    "/events/:id/tickets",
    "tickets",
    { id, ...pagination },
    paged,
  ),
  admin_event_purchases: read(
    "Event purchase records",
    "/events/:id/purchases",
    "money",
    { id, ...pagination },
    paged,
  ),
  admin_payouts: read(
    "Payout requests",
    "/payouts",
    "money",
    {
      status: {
        type: "string",
        enum: ["pending", "approved", "paid", "rejected"],
      },
      ...pagination,
    },
    paged,
  ),
  admin_payout: read(
    "Payout request and destination snapshot",
    "/payouts/:id",
    "money",
    { id },
  ),
  admin_approve_payout: change(
    "Approve payout request",
    "/payouts/:id/approve",
    "money",
    "payoutRequest",
    {},
    [],
  ),
  admin_reject_payout: change(
    "Reject payout request",
    "/payouts/:id/reject",
    "money",
    "payoutRequest",
    {},
    [],
  ),
  admin_record_paid_payout: change(
    "Record an external transfer already completed",
    "/payouts/:id/paid",
    "money",
    "payoutRequest",
    {
      reference: {
        type: "string",
        minLength: 3,
        maxLength: 500,
        title:
          "Reference of the transfer already completed outside this dashboard",
      },
    },
    ["reference"],
  ),
  admin_refund_recovery: read(
    "Unresolved original refunds",
    "/refund-recovery",
    "money",
    {},
    { collection: "records" },
  ),
  admin_activity: read(
    "Corporate activity",
    "/activity",
    "approve",
    { ...pagination },
    paged,
  ),
  admin_operation_receipt: read(
    "Original corporate operation receipt",
    "/operations/:id",
    "approve",
    { id },
  ),
};
