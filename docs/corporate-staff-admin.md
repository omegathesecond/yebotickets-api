# YeboTickets in the CEO super-admin

Scope: owned products only; contracts and YeboCars excluded. The CEO dashboard
remains the master super-admin. Corporate sub-admins prepare scoped requests;
CEO-authority decisions must use the existing central decision queue. Product
customers/organisers keep their existing business identities. Never manufacture
a product admin account or session for a corporate staff member.

Status: the native corporate boundary, scoped CEO controls and durable refund
caller cutover are implemented and tested locally in drafts. This is an initial
native workflow batch, not whole-product acceptance. No production migration,
workload configuration or deployment has occurred.

## Implemented native workflows

The existing shared CEO workspace renders source-owned sections for overview,
organisers, events, ticket records, settlements, payout requests, unresolved
original refunds and corporate audit history. Staff choose named organisers and
events; ticket-only staff receive minimal event context without organiser
contacts. The existing product services own queries, event visibility,
verification, unpublishing, settlement and payout transitions.

Event staff can create an event for a named real organiser, edit its details and
publication, and delete an empty event. Ticket staff can select an event and tier,
create/edit tiers, generate available inventory and delete unissued tiers. These
native actions reuse the same product validators, date checks, tier locks and
capacity calculation. Generation does not sell, charge or send tickets. Empty
edits fail visibly, and validation errors explain the existing product rule.

Tier reviews freeze the existing inventory records as well as the tier. Empty
event deletion freezes the tier definitions it would remove. New allocations or
definitions invalidate stale approvals. Deletion is transactional and preserves
reserved, sold and cancelled records; critical audit failure rolls back generated
inventory. Original event ownership and the post-sale settlement end-date guard
remain enforced. An omitted product owner is accepted only within the verified
corporate request context.

The shared event location conversion now preserves valid zero coordinates.
Shared frontend nested forms use their proper React component boundary, source
field titles and existing record path helper; this fixes a browser-observed event
form crash and missing nested organiser names without a separate Tickets renderer.

Writes prepare exact record versions in the existing central CEO decision queue.
Current authority is checked again at execution. Product mutations, the critical
corporate audit and the original receipt commit together; audit failure rolls
back the business change. Corporate staff are verified request actors, never
product sessions or manufactured product `User` records. Reviewer fields store
corporate staff separately from product-admin foreign keys.

Payout approval reserves an existing request. Recording paid requires a reference
for an external transfer already completed; it sends no payment. Terminal paid
requests cannot be rejected.

Finance staff can select a purchase and prepare a refund for that exact ticket.
The amount comes from its recorded allocation, with original gateway currency,
mode, request and cumulative proof verified before local cancellation. Explicit
FREE/zero/unreferenced tickets can be cancelled without a payment. Incomplete or
unconfirmed payment evidence fails in both native and existing organiser flows.

Corporate requests reuse the existing charge-wide refund lock and attempt. A
new immutable corporate-operation association links the original approval to
that existing attempt. Initial intent/audit/claim commit before dispatch; final
financial audit, ticket cancellation, hold release and original receipt commit
together after verified proof. A failed critical write retains the original
hold for recovery. Late replies cannot overwrite terminal receipts.

Refund recovery prepares a check bound to the selected ticket and original
attempt. Checking proof never sends a new refund. It can safely fence a prepared
sender before dispatch, retain pending payment, close proven failure or finalize
the exact success. Its provider calls read original proof; the local check,
audit, ticket accounting and receipt use the existing local transaction boundary.
Read failures fail the check and preserve the original payment hold.

The shared CEO adapter recognises the explicit capability
`reconcilesOriginalReceipt: true` on writes. The owning check returns
`originalOperationId` and `originalOperationState`; terminal states trigger the
existing authoritative receipt lookup and refresh the original central decision.
Non-corporate originals explicitly return null identities; no corporate approval
history is manufactured. The receipt capability uses the existing canonical
`operationId` parameter, with no alternate alias.

Financial completion and holder notifications remain separate outcomes. Immediate
notification failures are returned explicitly; proof checks send no notice and
financial receipts make no delivery claim. Durable notice tracking/recovery
remains part of the outstanding delivery work. Reviewed event cancellation
batches remain unimplemented.

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

Platform, organiser and event money read models now share recorded ticket
allocations and the existing SZL currency definition. Later edits to a ticket
tier's list price cannot change reported revenue. Missing, negative, invalid or
unsafe original money fails visibly; no list-price or zero substitution is made.
Existing product dashboards reuse the same repaired calculation.

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

- Product build and 537 tests across 34 suites passed. The tests include workload
  audience/caller rejection and the shared workspace label/binding contract.
  Google token verification is mocked in the unit tests; this is not live OIDC
  acceptance.
- Forty-one actual native Tickets/CEO/Pay HTTP/PostgreSQL checks passed with a
  non-superuser Tickets role: grants, private context, exact pagination, original
  paid amounts, central review, stale targets, revoked grants, separate corporate
  reviewers, atomic audit rollback, payout transitions, scope isolation and
  original receipts, exact native refund/recovery, failure/timeout races,
  financial audit/receipt rollback and automatic central receipt synchronization.
- The separate actual Tickets/YeboPay refund fixture passed eleven checks for
  existing organiser refunds and original-proof reconciliation. Payment and
  notification transports are simulated; no real payment or message is sent.
- CEO guarded build and focused native permission tests passed; 326 frontend
  tests and the guarded frontend build passed. Existing Jobs (38) and Learn (23)
  actual HTTP/PostgreSQL suites passed against the changed shared adapter.
- Disposable local desktop/mobile browser review verified a finance request,
  named organiser selection, CEO-only execution, saved corporate attribution and
  related ticket records. A second browser journey verified ticket-only named
  event/tier selection, a two-seat generation request, CEO execution, saved count,
  remaining inventory and full event creation with structured address/date fields.
  The refund journey verified a recorded SZL50 ticket despite its edited SZL999
  tier price, CEO-approved pending refund, selected original-proof check, both
  central receipts completing, saved financial history and the other ticket on
  the same charge staying sold. The 390px document fit its viewport. Sign-in uses
  the explicitly isolated fixture identity, not production authentication. An
  unrelated YeboShops review warning is visible because that route is absent
  from this local fixture; no successful data substitutes for it.
- Proof migration history was replayed from scratch locally. The additional
  corporate administration and corporate-refund association migrations were
  applied to named localhost fixtures only. The complete history, including the
  new refund association, replayed successfully on a fresh
  `yebotickets_refund_schema_fixture_20261123` database. Production migration
  remains pending.

Run the existing organiser-refund fixture from the CEO API checkout after
building both APIs:

```sh
YEBOTICKETS_TEST_SOURCE=/path/to/yebotickets-api \
YEBOTICKETS_ADMIN_TEST_DATABASE_URL=postgresql://fixture_tickets_runtime@127.0.0.1:55463/yebotickets_admin_fixture \
YEBOPAY_TEST_SOURCE=/path/to/yebopay-api \
YEBOPAY_ADMIN_TEST_DATABASE_URL=postgresql://admin@127.0.0.1:55463/yebopay_admin_fixture \
node --import tsx scripts/test-yebotickets-refunds.mjs
```

For the complete native suite, use the same source/database settings, also set
`PRODUCT_ADMIN_TEST_DATABASE_URL` to the named local CEO fixture and
`YEBOTICKETS_TEST_REFUNDS=1`, then run
`node --import tsx scripts/test-yebotickets-admin.mjs`.

The script reuses the CEO repository's guarded gateway fixture. It accepts only
named localhost databases and blocks external HTTP transports. It exercises the
existing organiser business service, not an invented corporate admin identity.

## Remaining before whole-product acceptance

Complete the remaining source inventory and native workflows: event cancellation
with its reviewed child refund set, admission, durable cancellation-notice
tracking/delivery recovery, purchase recovery, account workflows and configuration
where the owning product supports it.
Add explicit environment selection, environment-scoped grants and
environment-bound approvals before claiming both environments are manageable.
Current connection registration targets production only.

The canonical boundary is `/staff-admin` at the verified API origin. Source
Cloud Build configuration adds `CEO_DASHBOARD_SERVICE_ACCOUNT` and
`CEO_DASHBOARD_AUDIENCE` through the existing additive env list, preserving every
secret binding. The dev trigger must explicitly override the audience to
`https://dev-api.yebotickets.com`; the runtime rejects an audience that does not
match its actual prod/dev `K_SERVICE`. No trigger or runtime was updated.
CEO migration 129 uses the existing workload-auth registry contract and preserves
an explicitly disabled connection. Product migration
`20261123160000_corporate_administration` adds the shared operation store,
critical audit and separate corporate-reviewer fields. Migration
`20261123180000_corporate_refund_receipts` adds the immutable original association
and unique attempt identity. Preflight duplicate attempt identities before release;
never rewrite history to make the migration pass.

Read-only runtime check on 23 November 2026 identified domain mappings for
`yebotickets-api-prod` and `yebotickets-api-dev`, both running as
`yebotickets-runtime@hiyebo.iam.gserviceaccount.com`. Database and YeboPay secret
references are separated. Neither runtime had `DASHBOARD_API_KEY`; the native
integration instead reuses the verified CEO workload principal
`ceodashboard-runtime@hiyebo.iam.gserviceaccount.com`. No credential or IAM was
provisioned. Running-image provenance remains to be established before release.

Coordinate all active YeboPay caller cutovers and direct Neon schema/code
release. Verify real workload authentication, production reads, the operator's
accepted workflows and the approved cutover before retiring separate corporate
admin entry points. Drafts and local fixture evidence do not establish that cutover.
