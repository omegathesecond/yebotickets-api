# Ticket refund accounting

Apply the full migration history through `20261123140000_original_refund_proof` before deploying this API revision. The coordinated durable YeboPay API #30 release must be available first. Use the environment's Neon direct connection for `prisma migrate deploy`.

Each ticket's `amountPaid` is its refundable allocation of the shared `paymentRef`. Refund requests always send that allocation. YeboPay's `refunded_amount` is cumulative. The service requires the exact immutable original refund receipt: its saved attempt key, charge, amount, currency, mode, cumulative target, gateway request ID and successful provider proof. A 409 is a failed refund, never proof of success.

`TicketRefundLock.chargeId` is a database-wide unique claim shared by all tickets on that charge. The service re-reads the ticket after claiming, so a stale concurrent request cannot refund a ticket already finalized by another worker. Cancellation and claim release commit in one transaction. A concurrent cancellation reports the blocked ticket as failed; retry once the active refund completes.

## Uncertain outcomes

Every attempt sends the saved `TicketRefundLock.attemptId` as a stable,
product-prefixed gateway key. Timeouts, process crashes, pending/unknown processor
responses and local commit failures retain the charge claim. Tickets stay valid
until exact refund completion is proved. Neither current cumulative totals nor an
HTTP status alone can attribute a refund to one ticket.

The existing recovery endpoint now checks the original gateway receipt. Successful
proof atomically stores the attempt/gateway/provider identity on the ticket,
cancels its paid allocation and releases the claim. A pending/unknown original
stays blocked. A proven failed original can release its own hold for an explicitly
requested new attempt. Recovery cannot dispatch another refund. Missing or
conflicting proof fails visibly; see [refund recovery](refund-recovery.md).

Only structured canonical pre-dispatch rejections release an initial claim.
Unstructured proxy errors and ambiguous responses retain it. Notification failure
is still reported separately after money and local accounting have completed.

## Cancellation while payment is pending

Cancellation flags the event before scanning both sold and reserved tickets. Its response includes `pending` and per-ticket `pending` outcomes for unsettled orders; these are retained, not reported as refunded. Reservations keep their buyer and payment reference until YeboPay reports a terminal result. Reclaim never treats an old `PENDING` charge as failed. Before dispatch, each paid order stores an `attempt:<uuid>` reference and its per-ticket allocation on its reserved rows. The same reference is appended to the charge description as `[yebotickets:attempt:<uuid>]`: YeboPay echoes description in its signed charge DTO, but does not echo metadata. A verified terminal webhook replaces only matching reserved PROCESSING attempt references with the charge ID, then uses normal settlement/refund helpers. HTTP errors, lost responses and crashes retain this reference and ownership; reclaim reports unresolved attempt lookups as errors and never recycles these seats. If no terminal webhook arrives, manual payment reconciliation is required. A delayed PENDING response cannot overwrite a SUCCEEDED hold awaiting refund.

Settlement takes an Event row share lock in the same transaction as the ticket transition. The cancellation UPDATE conflicts with that lock: a sale committed first is included in cancellation's scan; cancellation committed first leaves the confirmed payment reserved for refund. Both synchronous charges and webhook/reclaim settlement use this transition. A second Event share lock gates ticket delivery and is held through the comms call, so cancellation waits for a delivery already started, or suppresses a delivery that has not started yet. No payment/refund gateway call holds a database transaction. Comms requests have a 10-second timeout per channel, within the delivery transaction’s 60-second budget.

A cancelled-event paid hold stays `reserved/SUCCEEDED` until the existing refund helper confirms its exact allocation was returned. Cancellation, webhook retries and reclaim can retry definite rejections using the same charge-wide refund claim. Ambiguous outcomes retain that claim for the reconciliation procedure above. Check-in rejects cancelled events even when a pre-cancellation sold ticket's refund has failed, and offline sync excludes those events. Previously downloaded offline caches require a fresh sync to see cancellation.

The original-refund proof migration above must be installed before this revision serves traffic.
