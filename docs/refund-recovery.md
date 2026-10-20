# Interrupted refund recovery

Apply `prisma migrate deploy` before deploying this API revision.

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

`CONFIRMED` records a validated successful gateway response before the local
accounting transaction. Recovery checks the authoritative charge total and
atomically finalizes the recorded ticket with lock release. Concurrent recovery
and cancellation cannot commit accounting twice or release a replacement token.

`DISPATCHING` means a processor request may have been sent. `REVIEW` is the
initial state for locks predating dispatch evidence. Both remain blocked unless
there is durable confirmation. A cumulative total alone cannot identify which
refund succeeded, and an unchanged total does not rule out delayed settlement.
The response returns `REVIEW_REQUIRED`, gateway evidence and instructions to
inspect processor records with payment operations. There is deliberately no
force-unlock or blind retry endpoint. A lost response, or a failed write of the
confirmation itself, may need payment-operations investigation; the current
YeboPay charge API provides no per-refund history for safe automatic attribution.

Gateway/DB failures propagate through normal API errors. No timer expires locks.
Notifications from the original refund flow still report delivery failures;
recovery repairs accounting and does not resend a potentially duplicate notice.
