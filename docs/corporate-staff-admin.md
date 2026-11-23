# YeboTickets in the CEO super-admin

Scope: owned products only; contracts and YeboCars excluded. The CEO dashboard
remains the master super-admin. Corporate sub-admins prepare scoped requests;
CEO-authority decisions must use the existing central decision queue. Product
customers/organisers keep their existing business identities. Never manufacture
a product admin account or session for a corporate staff member.

Status: refund dependency implementation and isolated validation are complete for
this batch. Native CEO catalogue/controls, grants, live configuration and cutover
are still unimplemented. No production migration or deployment has occurred.

## Reuse inventory

| Existing owning source | Reuse for central administration |
| --- | --- |
| `event.service.ts` and event controllers | Events, private/public visibility, publication moderation, creation/update and deletion rules |
| `ticket.service.ts` and ticket validators/controllers | Ticket tiers/inventory, exact ticket refunds, event cancellation, admission, payment/purchase recovery and delivery recovery |
| `organizer.controller.ts` | Organiser search/profile and verification; extract its existing query once where corporate authentication is needed |
| `settlement.service.ts`, `payout.service.ts` | Existing statements, payout eligibility, approval/rejection and recording a completed external transfer |
| `dashboard.service.ts` | Existing platform metrics; repair money semantics before treating its output as verified revenue |
| `config/platform.ts` | Shared SZL currency and platform fee settings; the ticket charge/refund path now imports this existing currency definition |
| Corporate product-admin boundary and CEO native adapter | Existing actor verification, schema forms, scoped grants, exact target reviews, central approvals and durable receipts |

Do not expose the existing dashboard metrics as authoritative finance unchanged:
`getDashboardMetrics` currently sums ticket-type list prices and labels them KES,
and `settlement.service.ts#ticketRevenue` substitutes list price for missing stored
payments. Those are real reuse gaps, not verified original-currency money. Do not
copy those substitutions into new native controls. Reconcile missing original
payment evidence and surface an error where required rather than inventing revenue.

Payout reviewer fields currently reference product `User` IDs. A corporate actor
must receive separate, attributed audit fields in the shared business operation,
with local changes and its corporate receipt in one transaction. Passing a CEO
staff ID as a product-user foreign key is invalid. Marking an approved payout
paid records an external transfer reference; it does not send a bank payment.

Event cancellation has external per-ticket effects. Freeze the exact reviewed
event/ticket set, preserve child refund attempts and reconcile original proof;
never clear an unknown parent receipt by sending a replacement batch. Reuse
the existing refund and cancelled-payment lifecycle rather than rebuild it.

## Durable refund cutover

The existing charge-wide `TicketRefundLock` retains its saved `attemptId` and
dispatch gate. Each new gateway request requires the stable key
`yebotickets-refund-<attemptId>`. The exact original gateway receipt must prove
request identity, charge, allocated amount, currency, mode, provider reference
and cumulative target. Current charge totals alone do not identify a ticket.

The existing recovery action reads original provider proof and cannot dispatch
a new refund. Pending/unknown outcomes preserve the ticket and charge hold.
A proven failed original can release only its own hold. Missing or mismatched
proof fails visibly. A verified success atomically stores the original attempt,
gateway request and provider reference, cancels the ticket and releases its lock.
Concurrent finalizers use a PostgreSQL row lock and converge on the same receipt.
Database constraints prevent completed proof or payment state from being replaced.

This requires durable YeboPay API PR #30 and migration
`20261123140000_original_refund_proof`, applied through the normal Neon direct
migration connection before dependent code. Historical attempts are not assigned
invented gateway history. See [recovery](refund-recovery.md) and
[ticket refund accounting](TICKET_REFUNDS.md).

## Local evidence

- Product build passed; 506 tests passed across 29 suites.
- Full migration history, including the proof migration, applied to the named
  disposable `yebotickets_admin_fixture` database only.
- Eleven actual Tickets/YeboPay HTTP/PostgreSQL checks passed with a non-superuser
  Tickets role. Payment and notification transports were simulated; there was
  no real payment, message, product sign-in or CEO-interface acceptance test.
- Checks cover shared-charge allocations, pending/failed refunds, gateway and
  processor acknowledgement loss, atomic local failure/recovery, original
  completion overlapping recovery, two concurrent reconcilers, currency mismatch
  before dispatch and immutable completed proof.

Run the shared fixture from the CEO API checkout after building both APIs:

```sh
YEBOTICKETS_TEST_SOURCE=/path/to/yebotickets-api \
YEBOTICKETS_ADMIN_TEST_DATABASE_URL=postgresql://fixture_tickets_runtime@127.0.0.1:55463/yebotickets_admin_fixture \
YEBOPAY_TEST_SOURCE=/path/to/yebopay-api \
YEBOPAY_ADMIN_TEST_DATABASE_URL=postgresql://admin@127.0.0.1:55463/yebopay_admin_fixture \
node --import tsx scripts/test-yebotickets-refunds.mjs
```

The script reuses the CEO repository's guarded gateway fixture. It accepts only
named localhost databases and blocks external HTTP transports. It exercises the
existing organiser business service, not an invented corporate admin identity.

## Remaining before whole-product acceptance

Implement the source-owned catalogue and real corporate actor path, resource
grants and environment-bound approvals; repair the money read models above;
connect the native CEO controls and central decisions; verify desktop/mobile
request/approval/recovery journeys and scoped data access. Inspect current
runtime bindings and services rather than following dated deployment notes.
Then complete coordinated migrations/deployment, authenticated production checks
and operator acceptance before retiring separate corporate admin entry points.

Read-only runtime check on 23 November 2026: domain mappings identify
`yebotickets-api-prod` and `yebotickets-api-dev`, both running as
`yebotickets-runtime@hiyebo.iam.gserviceaccount.com`. Their database and YeboPay
secret references are separated by environment. Neither runtime has
`DASHBOARD_API_KEY`; no Tickets dashboard API-key secret was found by name, and
the CEO runtime has no Tickets environment binding. Nothing was provisioned.
Prefer the already implemented workload-identity boundary used for YeboLearn,
with the verified CEO runtime `ceodashboard-runtime@hiyebo.iam.gserviceaccount.com`,
over inventing a second authentication system or borrowing a payment secret.
Verify that identity path end to end before enabling the native connection.
