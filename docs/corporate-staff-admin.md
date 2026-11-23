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
remains part of the outstanding delivery work.

Finance staff can now select an existing saved purchase, inspect its original
buyer, allocations and charge, and prepare recovery through the central CEO
queue. Recovery reuses the owning purchase service and advisory identity lock;
it cannot start a new charge or allocate replacement seats. Original payment
identity, currency and recorded total are checked before repairing references,
issuing admission or refunding a cancelled-event payment. The shared lock query
returns a supported scalar so actual PostgreSQL/Prisma recovery works.

The immutable initial recovery audit freezes the saved purchase identity and
recorded allocations. Source-owned original checks and queued continuation reuse
that audit and actual corporate actor, including after a process restart. The
existing recovery driver resumes interrupted requests; critical final audit and
original receipt commit together. A completed one-shot recovery request can
truthfully report pending payment; `sourceFinal` separately reports whether the
purchase is resolved. Failed allocations cannot expose or reset later buyers'
reused seats. Contradictory payment evidence fails visibly.

Ticket staff can browse existing delivery work and its original attempt/status
inside the same workspace. Detail reads preserve the actual source ID, including
its colon, through a validated query field. New WhatsApp/email attempts preserve
their original recipient, channel and dispatch identity before any send, with
separate immutable acknowledgement history. That history survives failure of the
mutable order result. A lost gateway acknowledgement or failed acknowledgement
write stays unknown and never silently chooses another channel or resends.
Definite rejection can use the existing email path, preserving both attempts.

The Tickets client now reads YeboLink's canonical `message_id` send response;
the former `id` expectation rejected real successful acknowledgements. No
alternate response alias is accepted. The original workspace-scoped YeboLink
GET receipt is available through exact central CEO review. It verifies message,
recipient, channel and recorded intent, preserves accepted/queued separately
from gateway delivered/read, and rejects conflicting or regressive evidence.
Critical local audit and receipt progress commit together. Reads dispatch no
message. Historical or interrupted sends without a saved message identity get
no invented receipt. Existing permitted buyer retries append history; native
CEO-reviewed retries now reuse that same claim and dispatcher.

Cancellation and refund finalization now save one immutable cancellation-notice
intent in the same database transaction. It retains the actual ticket, holder,
event, recorded refund allocation/currency and original refund identities;
missing evidence cannot create a fictional notice. Original recipient and
content remain fixed after later contact/event edits. The financial receipt
links its real notice identity and makes no message-delivery claim.

Notice dispatch reuses the same communications client, per-channel history and
exact original receipt check, with exactly one owning delivery-order or
cancellation-notice identity. The existing delivery recovery timer resumes only
never-started notices. Sending interruptions become unknown; failed or unknown
notices are not automatically replaced. Original acknowledgement/history survives
work-result failure, and a CEO-reviewed proof read can repair only that original
notice generation. Proof reads send no notice or money. Intent/history survives
parent ticket deletion. No historical notice is invented or backfilled.

The native Cancellation notices section reuses the shared workspace and central
proof actions. Original recipient and free-form message content are omitted from
read models; ticket-only access cannot bypass financial redaction through message
text. Useful interruption errors are visible without exposing database internals.
Explicit CEO-reviewed notice retries now reuse the same reviewed-message protocol
as admission delivery. Each owning service retains its own evidence, claim and
transport rules. Shared code owns exact initial audit/claim, immutable original
intent, final audit/work/receipt, sealed command history and proof reconciliation.
The selected notice binds its actual generation. Unknown prior sends require
explicit acknowledgement of duplicate risk, including older unresolved history.
Accepted/queued or delivered/read evidence prevents another send; late stronger
proof suppresses an already-claimed retry. Source generation guards remain intact.
The original saved recipient/content never change and a missing contact cannot be
silently redirected. No financial operation or new ticket can occur. The existing
message proof action can close the original notice retry and central CEO decision
with one gateway read. Failed/unknown commands retain their original outcome when
newer generations finish. Ticket deletion does not erase the notice intent.

The source metadata supplies selected generation bindings and original notice
retry history to the existing shared forms/decision queue. No separate product
renderer, staff-as-product-user identity, compatibility alias or weaker lease was
introduced.

Retry requests bind the exact current work generation as well as the reviewed
order. A genuinely unattempted order has no fabricated attempt record. The
existing source/central unresolved-operation guards stay intact: an explicitly
acknowledged new generation does not clear or rewrite an older unknown command.
Distinct approvals for one generation compete on one conditional claim. The
initial corporate audit and claim commit together before dispatch; the final
audit, work result and original receipt commit together. Original message proof
can finish an interrupted original command and refresh its central CEO decision
without sending anything. An accepted command remains distinct from later
gateway delivery, and sealed command outcomes survive later retries.

Known delivered/read proof blocks resend in both native and buyer flows. Any
older unknown send still requires explicit duplicate-risk acknowledgement after
a later proven failure; the background worker holds it instead of replacing it.
Stronger proof arriving after approval suppresses the claimed replacement before
dispatch. Contacts are locked before the existing Event/Ticket order, followed by
work and history; original content/proof is rechecked under those locks before
sending. Changed recipients cannot receive a previously approved order. The
immutable message history and exact command receipt remain readable when mutable
delivery work is removed. Source-owned generation and action bindings reuse the
existing workspace controls; no separate renderer or product staff identity is
added.

Admission uses the existing scanner preview, conditional Event/Ticket admission
claim and durable operator receipt. Ticket staff select an actual ticket code and
see its current admission state and holder/event details. Confirmation prepares
an exact central CEO decision. Both event cancellation and an intervening scanner
admission invalidate the saved review. The execution lock order matches the
existing scanner's Event-then-Ticket order. Check-in, the original scanner receipt,
corporate audit and corporate operation commit together; critical audit failure
rolls them back together. Product and verified corporate operator kinds are stored
separately, so identical actor strings cannot take over each other's receipt.
Existing receipts are classified as product operators by the additive migration;
no product account is manufactured for a corporate staff member.

Event cancellation freezes the exact sold/reserved set under the same Event and
Ticket locks used by existing sale/admission transitions. The existing owning
cancellation transition stops sales and admission. Its event flag, immutable
manifest, saved reviewed hash and critical parent audit commit together before
any refund. Each originally eligible ticket has a fixed child operation identity
and exact review version; it reuses the existing single-ticket refund service,
charge-wide lock and original proof. Existing unknown holds are adopted without
replacement money or manufactured corporate child history.

The existing startup/periodic reservation-recovery driver and authenticated
manual recovery route now share one ticket-recovery orchestration. It resumes
only never-started children from durable, actually approved manifests. The saved
corporate actor and reviewed intent are verified against the immutable audit;
no product account/session is created. Work is bounded per pass and uses the
existing per-ticket dispatch gate. Unknown or failed attempts never get an
automatic replacement. A changed original ticket requires a fresh exact refund
review. Pending reservations stay owned until the existing purchase/settlement
lifecycle supplies authoritative evidence; a newly confirmed payment can also
use the existing exact ticket refund action.

The native continuation action records a local queued request/audit/receipt
before waking the existing worker. A queued receipt makes no completed-payment
claim. The original manifest remains recoverable after restart. The native proof
check never starts a refund or sends a notice. Each pass reads at most one
original provider attempt and rotates never-checked/oldest pending holds using
actual `lastCheckedAt` evidence, so large sets commit progress within the gateway
timeout budget. It reconciles existing holds and
fences delayed children whose required initial audit/claim never committed.
Financially completed children remain committed if the aggregate write fails;
the final parent financial audit and terminal receipt commit together on verified
original evidence. The shared adapter then refreshes the original central CEO
decision. Later failed-attempt history is preserved when a separately approved
fresh ticket refund resolves the parent.

Finance staff can open a named cancellation, read resolved/remaining counts and
errors, inspect paginated ticket outcomes, and prepare any required exact refund
from the selected record. Bulk evidence queries reuse saved original allocations;
there is no per-row API fan-out or current-price substitution. Cancellation
manifests and their original financial intent cannot be edited or deleted.

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

Event cancellation reuses the existing per-ticket refund and cancelled-payment
lifecycle. An unresolved parent remains held against its original immutable set;
proof recovery cannot send a replacement batch.

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

- Product build and 540 tests across 34 suites passed. The tests include workload
  audience/caller rejection and the shared workspace label/binding contract.
  Google token verification is mocked in the unit tests; this is not live OIDC
  acceptance.
- 124 actual native Tickets/CEO/Pay HTTP/PostgreSQL checks passed with a
  non-superuser Tickets role: grants, private context, exact pagination, original
  paid amounts, central review, stale targets, revoked grants, separate corporate
  reviewers, atomic audit rollback, payout transitions, scope isolation and
  original receipts, exact native refund/recovery, failure/timeout races,
  financial audit/receipt rollback, automatic central receipt synchronization,
  replay-safe native admission, scanner races, cancelled events, operator-kind
  isolation, atomic admission/audit/receipt rollback, immutable cancellation
  manifests, same-charge partial outcomes, queued/concurrent original recovery,
  pending settlement, stale queued work, original-sender fencing and aggregate
  financial audit/receipt failure recovery, bounded fair proof progress across
  distinct charges, and an actual blocked-Event/NOWAIT
  Ticket probe verifying the deadlock repair. Purchase checks also cover saved
  allocation recovery, no new charge, original amount/currency mismatch,
  payment-read outages, concurrent continuation, initial/final audit failures,
  cancelled settlement, original refund proof, failed/reused seats and
  contradictory payment evidence.
  The delivery additions use the actual YeboLink send/receipt route modules,
  validators, scopes and rate-limit middleware with injected localhost fixture
  identity and message storage/send. They verify canonical acknowledgement,
  original identity/intent, scope/outage failures, immutable history, no
  automatic duplicate after lost acknowledgement or database failure, stronger
  receipt preservation and critical audit rollback. This route-contract fixture
  does not establish live credentials, provider delivery or the full YeboLink
  credit/queue lifecycle.
  Retry checks include explicit risk acknowledgement, older uncertainty, central
  request/executor attribution, generation races, immutable intent, initial/final
  audit and receipt failures, original CEO-receipt synchronization, revoked
  grants, post-claim cancellation/contact/proof changes, historical outcomes and
  concurrent retained-history reads. An actual blocked-User/NOWAIT Event/Ticket
  probe verifies the contact-lock order.
  Notice cases cover immutable paid/free intent, financial/notice rollback,
  initial recovery and preserved history after deletion. Reviewed notice cases
  additionally verify no money/ticket effects, CEO-only execution, unknown-risk
  and exact-generation binding, older uncertainty, critical initial/final writes,
  original receipt recovery/synchronization, concurrent approvals and late
  delivered proof suppressing dispatch.
- The separate actual Tickets/YeboPay refund fixture passed eleven checks for
  existing organiser refunds and original-proof reconciliation. Payment and
  notification transports are simulated; no real payment or message is sent.
- CEO guarded build passed. Earlier focused native permission, 326 frontend
  tests/build and Jobs (38)/Learn (23) actual HTTP/PostgreSQL regressions remain
  applicable: this batch changes no shared CEO adapter or frontend logic.
- Disposable local desktop/mobile browser review verified a finance request,
  named organiser selection, CEO-only execution, saved corporate attribution and
  related ticket records. A second browser journey verified ticket-only named
  event/tier selection, a two-seat generation request, CEO execution, saved count,
  remaining inventory and full event creation with structured address/date fields.
  The refund journey verified a recorded SZL50 ticket despite its edited SZL999
  tier price, CEO-approved pending refund, selected original-proof check, both
  central receipts completing, saved financial history and the other ticket on
  the same charge staying sold. The 390px document fit its viewport. Sign-in uses
  the explicitly isolated fixture identity, not production authentication.
  Native admission review verified ticket staff preparing an exact code, CEO
  execution, the saved successful operation and reopening the same ticket as
  used. The cancellation journey verified a finance request for two recorded
  SZL50 tickets (tier999), CEO-approved pending outcome, one original proof
  completing, queued continuation of the remaining original ticket, both refunds
  confirmed and the original CEO decision synchronized. The mobile 390px document
  also fit its viewport. An
  unrelated YeboShops review warning is visible because that route is absent
  from this local fixture; no successful data substitutes for it.
  Purchase browser review verified finance preparing a two-ticket SZL100
  recovery, CEO execution, persisted issued status and one original delivery
  attempt. The 390px delivery-detail document fit the viewport. All payments
  and communications remained simulated on named localhost databases.
  The message-receipt journey verified ticket staff selecting original message
  history, preparing a receipt-only central request, CEO approval and a saved
  result with distinct original queued and later read/delivered evidence. The
  390px document fit the viewport. No message was resent by receipt checks.
  The retry walkthrough verified a known rejection and an unknown send: ticket
  staff prepares both; unknown preparation fails without explicit risk
  acknowledgement; the CEO approves; accepted original commands and executor
  receipts are saved. The older unknown history remains visible beside the new
  queued acknowledgement. The 390px document fits its viewport. The message
  gateway remains the owning local route-contract fixture, not a real provider.
  The cancellation-notice journey verified ticket-only staff opening retained
  notice/message history, preparing a proof-only request, CEO execution and a
  saved completed result with separate queued and delivered evidence. Mobile
  status filtering fit the 390px viewport; original recipients/message text were
  absent from the ticket-staff read view. No message was sent by the proof read.
  The notice-retry walkthrough verified known-failure and unknown-send staff
  requests, explicit duplicate-risk acknowledgement, CEO execution and retained
  original retry/message history. The older unknown attempt remains beside the
  new accepted/queued message. Desktop and 390px layouts passed; temporary
  viewport changes were reset. All sends stayed in the local Link fixture.
- Proof migration history was replayed from scratch locally. The additional
  corporate administration and corporate-refund association migrations were
  applied to named localhost fixtures only. The complete history, including the
  new refund association, replayed successfully on a fresh
  `yebotickets_refund_schema_fixture_20261123` database. The admission migration
  was also included in a fresh complete replay of `yebotickets_admin_fixture`.
  The complete final history through proof-check progress also replayed on a fresh
  `yebotickets_cancellation_final_schema_fixture_20261123` database.
  The complete history through purchase intent also replayed on a fresh
  `yebotickets_purchase_schema_fixture_20261123` database.
  The history through delivery-message receipts also replayed from scratch on
  `yebotickets_delivery_schema_fixture_20261123`.
  The complete history through corporate delivery retry intent replayed on fresh
  `yebotickets_retry_schema_fixture_20261123`.
  The complete final history through cancellation-notice work replayed on fresh
  `yebotickets_notice_schema_fixture_20261123`.
  The complete history through reviewed notice retries replayed on fresh
  `yebotickets_notice_retry_schema_fixture_20261123`.
  Production migration remains pending.

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

Complete the remaining source account workflows and configuration where supported.
The existing organiser deletion route and role-based profile field projection
remain to be integrated with exact corporate targets and retained financial history.
Currency/commission currently live in environment configuration; the inspected
source has no runtime settings API. Do not present fictional working settings.
Notice tracking, initial recovery, explicit reviewed retries and original proof
checks are implemented; this does not claim whole-product acceptance.
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
and unique attempt identity. Migration `20261123190000_corporate_admission`
adds separate operator-kind attribution to existing admission receipts.
`20261123200000_event_cancellation_manifest` preserves one immutable original
cancellation manifest per event and extends immutable original financial intent.
`20261123210000_refund_proof_check_progress` records actual nonterminal proof-read
timestamps on the existing hold; historical rows are not assigned invented reads.
`20261123220000_purchase_recovery_intent` extends immutable original financial
intent to the existing purchase-recovery audit.
`20261123230000_delivery_message_receipts` adds immutable message-attempt history
without manufacturing identities for past sends. Receipt reads require the
existing product's YeboLink API key to have `read_messages`; verify actual
production scopes before release. This change provisions no credential or scope.
`20261123233000_corporate_delivery_retries` preserves original corporate retry
intent and one owning audit association per planned dispatch generation.
Preflight duplicate attempt identities before release;
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
