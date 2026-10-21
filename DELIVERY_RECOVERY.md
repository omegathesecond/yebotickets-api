# Ticket order delivery

Apply `20261021000000_ticket_order_delivery` before running this revision.
No migration or deployment has been run by this change.

Issuance creates a pending `TicketOrderDelivery` and attaches every ticket in the
same database transaction. Paid orders use `paid:<paymentRef>`; each free purchase
gets one `free:<uuid>` shared by all its tickets. Repeated settlement webhooks do
not create another work item. Existing untracked tickets retain no asserted send
status; the migration does not guess whether historic messages were sent.

Startup and a one-minute timer recover due pending/failed work in batches of 20.
Cloud Run timers require an active instance; an external scheduler can also call
`POST /api/internal/recover-ticket-deliveries` with the existing internal key.
The buyer can retry via authenticated `POST /api/tickets/:ticketId/delivery/retry`.
Ownership, account rate limiting and a durable one-minute per-order cooldown apply.
Retry uses existing ticket codes and canonical message/QR composition; it never
calls payment creation or inventory issuance. A partial refund excludes voided
tickets; a cancelled event suppresses the whole message. Refund claims defer sends.

`sent` means YeboLink acknowledged acceptance, not proof the recipient read the
message. Explicit pre-dispatch rejections become `failed` and retry with exponential
backoff (one minute to one hour). Transport errors, server errors, missing/malformed
acknowledgements and process interruptions may have happened after acceptance.
Those remain `unknown`; automatic recovery never resends them or switches channels.
A `sending` attempt interrupted for two minutes becomes `unknown`. Manual retry
requires `acknowledgeDuplicateRisk: true`, with that risk explained in buyer details.
The provider exposes no idempotency/reconciliation guarantee in the existing helper,
so exactly-once external delivery cannot be promised. Atomic claims and attempt
fencing prevent ordinary concurrent sends; ambiguous retries can duplicate messages.

Delivery failure never rolls back paid tickets or marks them sent. Failed outcome
persistence leaves the attempt unconfirmed for recovery, rather than inventing a
successful delivery state. Database and provider errors are logged; buyer wallet
reads persistent state independently of settlement/webhook response lifetimes.
