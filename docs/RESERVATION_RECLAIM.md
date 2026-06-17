# Expired-reservation reclaim sweep

When a buyer pays for a priced ticket with an async method (mobile money), the
seat is RESERVED and the charge left `PENDING` until YeboPay confirms. If the
buyer abandons the prompt, that hold must eventually be freed so the seat
returns to inventory.

`reclaimExpiredReservations()` (`src/services/ticket.service.ts`) resolves one
batch of stale holds — authoritatively, by asking YeboPay the true charge
status (never by guessing from the clock). On its own it was only ever invoked
lazily, best-effort, for the single ticket type a buyer happened to be
purchasing. A ticket type that filled with abandoned `PENDING` holds and then
got **no further purchase attempts** would strand its inventory indefinitely.

## What runs it now

`src/services/reservationReclaim.service.ts` runs the reclaim **globally**
(across every ticket type) on a schedule, via two interchangeable mechanisms:

### 1. In-process scheduler (default — zero infra)

`startReservationReclaimScheduler()` is started from `server.ts` after the
server boots. It runs `runReclaimSweep()` every ~5 minutes (plus once ~5s after
boot to clear any backlog from a fresh deploy).

| Env var | Default | Meaning |
|---|---|---|
| `RESERVATION_RECLAIM_ENABLED` | `true` | Set `false` to disable the in-process timer (e.g. when Cloud Scheduler drives the endpoint instead). |
| `RESERVATION_RECLAIM_INTERVAL_MS` | `300000` (5 min) | Sweep interval. |

The timer is `unref()`'d (never keeps the process alive on its own) and stopped
on `SIGTERM`.

### 2. Internal HTTP endpoint (for Cloud Scheduler)

`POST /api/internal/reclaim-reservations`, authenticated with the
`x-internal-key` header against `INTERNAL_API_KEY`. Returns the sweep tally:

```json
{ "success": true, "summary": { "scanned": 7, "finalized": 1, "released": 4, "stillPending": 2, "errors": 0, "iterations": 1, "skipped": false } }
```

Fails **closed**: if `INTERNAL_API_KEY` is unset the endpoint returns 503 (never
silently open). A whole-sweep failure (e.g. the DB read fails) returns 5xx so
the scheduler run is marked failed — never a fake `ok`.

To drive it from Cloud Scheduler instead of the in-process timer, set
`RESERVATION_RECLAIM_ENABLED=false`, bind `INTERNAL_API_KEY` as a secret, then:

```bash
gcloud scheduler jobs create http yebotickets-reclaim-reservations \
  --location=europe-west1 \
  --schedule="*/5 * * * *" \
  --uri="https://api.yebotickets.com/api/internal/reclaim-reservations" \
  --http-method=POST \
  --headers="x-internal-key=$INTERNAL_API_KEY"
```

## Safety

The sweep is **fully idempotent and concurrency-safe**: the underlying writes
(`releaseReservedTicket`, `settleSucceededCharge`) are guarded `updateMany` /
status checks, so running it from multiple Cloud Run instances at once — or
retrying it — can never oversell, double-release, or double-deliver.

`runReclaimSweep()` drains successive full batches while each makes progress
(`finalized + released > 0`), capped at 50 batches/tick. It deliberately halts
the instant a full batch frees nothing (a backlog of holds still within the
hard-expiry window stays `reserved`, so re-fetching would just spin) — those
are picked up on the next tick once they cross the window. An overlap guard
skips a tick if the previous sweep is still running.
