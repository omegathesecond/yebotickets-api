# Interrupted refund recovery

Draft implementation; not deployed. Apply migration
`20261123140000_original_refund_proof` using the environment's Neon direct
connection before dependent code serves traffic. Requires the coordinated durable
YeboPay refund release (API PR #30), including the other active caller cutovers.

Admin JWTs can call:

- `GET /api/tickets/refund-recovery`: outstanding charge locks, attempt IDs,
  recovery status, diagnostic detail and recovery action.
- `POST /api/tickets/refund-recovery/:chargeId/reconcile` with JSON
  `{"attemptId":"<token from list>"}`: reconcile precisely that attempt.

The POST never calls the money-moving refund endpoint. `PREPARED` means no
caller crossed the atomic dispatch gate; recovery conditionally releases it.
A caller still doing preflight cannot subsequently dispatch after that release.
`REJECTED` records a definitive gateway rejection before release; it is also
safe to release if the original cleanup was interrupted. `RETRYABLE` means the
normal ticket refund or event cancellation can now be retried.

Every dispatched attempt uses `yebotickets-refund-<attemptId>` as its required
YeboPay operation key. Recovery calls the original gateway reconciliation endpoint,
which reads provider proof and cannot dispatch another refund. It verifies the
original key, request ID, charge, per-ticket amount, currency, mode, provider reference
and that attempt's cumulative target. Current charge totals alone never prove which
ticket was refunded.

A verified successful original receipt finalizes the ticket and stores
`refundAttemptId`, `refundGatewayRequestId` and the provider reference in the same
transaction that releases the charge lock. A row lock serializes finalizers; an
original response arriving after recovery converges on the same stored receipt.
The completion identity and payment state are immutable. Other tickets sharing the
charge keep their own allocated amount and distinct attempt IDs.

A documented `PENDING`/`UNKNOWN` receipt returns `REVIEW_REQUIRED` and preserves the
ticket and charge hold. A proved `FAILED` original receipt can release its own hold
and return `RETRYABLE`; recovery never sends the next payment. A missing original
receipt, malformed response or mismatched proof fails through the normal API error
channel and retains the hold. Historical attempts without an original gateway
receipt require payment-operations investigation; no invented key history or
compatibility success path is provided. There is no force-unlock endpoint.

Gateway/DB failures propagate through normal API errors. No timer expires locks.
Notifications from the original refund flow still report delivery failures;
recovery repairs accounting and does not resend a potentially duplicate notice.
