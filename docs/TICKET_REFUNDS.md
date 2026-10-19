# Ticket refund accounting

Apply migration `20261019120000_add_ticket_refund_lock` before deploying this API revision. Use the environment's Neon direct connection for `prisma migrate deploy`.

Each ticket's `amountPaid` is its refundable allocation of the shared `paymentRef`. Refund requests always send that allocation. YeboPay's `refunded_amount` is cumulative: the service compares it with the pre-request total plus the ticket allocation, and requires `processor_status: SUCCEEDED`. A 409 is a failed refund, never proof of success.

`TicketRefundLock.chargeId` is a database-wide unique claim shared by all tickets on that charge. The service re-reads the ticket after claiming, so a stale concurrent request cannot refund a ticket already finalized by another worker. Cancellation and claim release commit in one transaction. A concurrent cancellation reports the blocked ticket as failed; retry once the active refund completes.

## Uncertain outcomes

YeboPay's current refund route does **not** deduplicate refund requests. Never expire or automatically delete these locks. A timeout, process crash, pending/failed processor response, inconsistent response, or local commit failure can leave a claim behind. All further refunds on that charge fail visibly until an operator reconciles it. The ticket stays sold until confirmed refunded.

For reconciliation, inspect the lock (`ticketId`, `amount`, `refundedBefore`, `createdAt`), the ticket, YeboPay charge history, and the actual processor refund record. A cumulative charge total alone cannot identify which ticket was refunded.

- If the processor conclusively confirms the exact ticket refund succeeded, finalize that ticket (`status=cancelled`, `paymentStatus=REFUNDED`, refund reference and timestamps, clear the buyer refund request) and delete the claim in a **single database transaction**.
- If the processor conclusively confirms no refund occurred and none remains pending, delete the claim and retry through the normal refund endpoint.
- Otherwise retain the claim and resolve with the payment provider. Never resend an uncertain refund.

Known pre-dispatch YeboPay rejections (400/401/403/404/409/501) release the claim without changing ticket state, allowing a corrected request to retry. Notifications occur only after confirmed refund and local commit.

## Cancellation while payment is pending

Cancellation flags the event before scanning both sold and reserved tickets. Its response includes `pending` and per-ticket `pending` outcomes for unsettled orders; these are retained, not reported as refunded. Reservations keep their buyer and payment reference until YeboPay reports a terminal result. Reclaim never treats an old `PENDING` charge as failed. An unreferenced `PROCESSING` hold identifies an in-flight create-charge call; a crash in that window requires manual payment reconciliation rather than recycling the seat.

Settlement takes an Event row share lock in the same transaction as the ticket transition. The cancellation UPDATE conflicts with that lock: a sale committed first is included in cancellation's scan; cancellation committed first leaves the confirmed payment reserved for refund. Both synchronous charges and webhook/reclaim settlement use this transition. A second Event share lock gates ticket delivery and is held through the comms call, so cancellation waits for a delivery already started, or suppresses a delivery that has not started yet. No payment/refund gateway call holds a database transaction. Comms requests have a 10-second timeout per channel, within the delivery transaction’s 60-second budget.

A cancelled-event paid hold stays `reserved/SUCCEEDED` until the existing refund helper confirms its exact allocation was returned. Cancellation, webhook retries and reclaim can retry definite rejections using the same charge-wide refund claim. Ambiguous outcomes retain that claim for the reconciliation procedure above. Check-in rejects cancelled events even when a pre-cancellation sold ticket's refund has failed, and offline sync excludes those events. Previously downloaded offline caches require a fresh sync to see cancellation.

No new migration is needed for this lifecycle; the refund-lock migration above must already be installed.
