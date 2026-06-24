import prisma from '../config/prisma';
import {
  reclaimExpiredReservations,
  RECLAIM_BATCH,
  ReclaimSummary,
} from './ticket.service';

// ===========================================================================
// Global expired-reservation reclaim SWEEP + in-process scheduler.
//
// reclaimExpiredReservations() resolves stale holds for ONE batch of stale
// rows (optionally scoped to a single ticketTypeId). On its own it is only ever
// invoked best-effort, lazily, for the one ticket type a buyer happens to be
// purchasing — so a ticket type that fills with abandoned PENDING holds and
// then gets no further attempts strands its inventory forever.
//
// This module closes that gap: it runs the reclaim GLOBALLY (no ticketTypeId,
// so every type is swept) on a periodic timer (~5 min) AND exposes the same
// sweep for an external driver (Cloud Scheduler -> POST /api/internal/
// reclaim-reservations). The underlying per-row writes (releaseReservedTicket /
// settleSucceededCharge) are guarded updateMany / status checks, so the sweep
// is fully idempotent and safe to run concurrently from multiple Cloud Run
// instances or to retry — no oversell, no double-release, no double-delivery.
//
// CROSS-INSTANCE SINGLE-FLIGHT: the in-process timer runs in EVERY Cloud Run
// instance, so when the service scales to N instances all N would otherwise
// sweep every ~5 min at once — safe (see above) but wastefully redundant (each
// instance re-asks YeboPay getCharge for the same stale rows). Each sweep
// therefore first tries to grab a Postgres TRANSACTION-scoped advisory lock
// (pg_try_advisory_xact_lock); only the instance that wins runs the drain, the
// rest skip this tick. The lock auto-releases when the wrapping transaction
// ends (commit/rollback/connection drop), so a crashed leader never wedges the
// sweep — and it works through a PgBouncer pooler because the whole acquire +
// drain runs inside ONE interactive transaction pinned to one backend. This is
// pure cost/efficiency hardening; correctness never depended on it.
//
// Failures are surfaced LOUDLY (logged at error level; the HTTP path rethrows
// to a 5xx) — never swallowed and never replaced with a fake "ok" (CLAUDE.md:
// no silent fallbacks).
// ===========================================================================

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Default ceiling on how long the advisory-lock-holding transaction may stay
 * open (i.e. how long one drain may run). Generously above any realistic sweep
 * — a full 1000-row backlog at even ~0.5s/row finishes well inside this — so it
 * only ever trips on a genuinely stuck sweep, which SHOULD surface as an error.
 * Overridable via RESERVATION_RECLAIM_LOCK_TIMEOUT_MS.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Two 32-bit keys identifying the reclaim advisory lock (pg_advisory_xact_lock
 * takes int4, int4). Arbitrary but FIXED + namespaced to YeboTickets so the
 * pair is effectively unique within this database. 'YT' / 'RC'.
 */
const ADVISORY_LOCK_KEY_1 = 0x5954; // 'YT'
const ADVISORY_LOCK_KEY_2 = 0x5243; // 'RC'

/** True unless RESERVATION_RECLAIM_SINGLE_FLIGHT=false (default on). */
const singleFlightEnabled = (): boolean =>
  (process.env.RESERVATION_RECLAIM_SINGLE_FLIGHT ?? 'true').toLowerCase() !==
  'false';
/**
 * Cap on batches drained per sweep tick (50 * RECLAIM_BATCH = 1000 rows). A
 * single tick keeps clearing actionable backlog up to this ceiling; whatever is
 * left is picked up next tick. The cap stops a pathological backlog from
 * monopolising one tick indefinitely.
 */
const MAX_SWEEP_ITERATIONS = 50;

/** Guards against overlapping ticks (a slow YeboPay must not let sweeps stack). */
let sweepInFlight = false;
/** Single-start guard so the scheduler can't be wired up twice. */
let timer: NodeJS.Timeout | null = null;

export interface SweepResult extends ReclaimSummary {
  /** Number of reclaim batches drained this sweep. */
  iterations: number;
  /** True when this call was skipped because another sweep was already running. */
  skipped: boolean;
}

const emptyResult = (skipped: boolean): SweepResult => ({
  scanned: 0,
  finalized: 0,
  released: 0,
  stillPending: 0,
  errors: 0,
  iterations: 0,
  skipped,
});

/**
 * Drain the global reclaim across ALL ticket types, running successive batches
 * while each full batch still makes progress (finalized + released > 0).
 *
 * The progress guard is deliberate: reclaimExpiredReservations() takes only
 * RECLAIM_BATCH rows (un-ordered) and rows still PENDING within the hard-expiry
 * window stay `reserved`, so they are re-fetched on every call. Looping on
 * "batch smaller than RECLAIM_BATCH" would spin forever on a backlog of live
 * holds; looping only while a FULL batch produced an actionable change drains
 * the dead/settled holds yet halts the instant a batch is all still-pending.
 *
 * Never throws on a per-row YeboPay error (those are counted in summary.errors
 * by reclaimExpiredReservations). A catastrophic failure — e.g. the DB read
 * itself failing — DOES propagate so the caller (timer logs it; HTTP returns
 * 5xx) sees the outage loudly.
 */
const drainSweep = async (): Promise<SweepResult> => {
  const totals = emptyResult(false);
  for (let i = 0; i < MAX_SWEEP_ITERATIONS; i++) {
    const batch = await reclaimExpiredReservations(); // global: every ticket type
    totals.scanned += batch.scanned;
    totals.finalized += batch.finalized;
    totals.released += batch.released;
    totals.errors += batch.errors;
    totals.stillPending = batch.stillPending; // residual held by the final batch
    totals.iterations++;

    const fullBatch = batch.scanned >= RECLAIM_BATCH;
    const madeProgress = batch.finalized + batch.released > 0;
    if (!fullBatch || !madeProgress) break;
  }
  return totals;
};

/**
 * Run `drain` under a cluster-wide Postgres transaction advisory lock so only
 * ONE Cloud Run instance sweeps per tick. If another instance already holds the
 * lock, returns a skipped result instead of duplicating its work.
 *
 * The advisory lock is TRANSACTION-scoped: it is held for the lifetime of the
 * wrapping interactive transaction and released automatically on commit (or on
 * rollback / connection loss), so a leader that crashes mid-sweep can never
 * wedge the lock. The drain runs INSIDE the transaction callback — the locking
 * connection just sits idle holding the lock while the drain's own writes use
 * the normal pooled client; advisory locks contend with nothing else, so there
 * is no deadlock and no table/row is held.
 *
 * Disable with RESERVATION_RECLAIM_SINGLE_FLIGHT=false (e.g. single-instance
 * dev, or when a single external Cloud Scheduler is the only driver) to run the
 * drain directly without touching the lock.
 */
const withCrossInstanceLock = async (
  drain: () => Promise<SweepResult>
): Promise<SweepResult> => {
  if (!singleFlightEnabled()) {
    return drain();
  }

  const timeout =
    Number.parseInt(process.env.RESERVATION_RECLAIM_LOCK_TIMEOUT_MS || '', 10) ||
    DEFAULT_LOCK_TIMEOUT_MS;

  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY_1}, ${ADVISORY_LOCK_KEY_2}) AS locked`;
      if (!rows[0]?.locked) {
        console.log(
          '[reclaim] another instance holds the sweep lock — skipping this tick'
        );
        return emptyResult(true);
      }
      return drain();
    },
    { timeout, maxWait: 10_000 }
  );
};

/**
 * Run the global reclaim sweep, gated so it runs at most once at a time per
 * instance (`sweepInFlight`) AND at most once across the whole cluster per tick
 * (Postgres advisory lock — see withCrossInstanceLock). Returns the aggregated
 * tally; `skipped: true` means this call did no work because another sweep (in
 * this process or another instance) was already running.
 */
export const runReclaimSweep = async (): Promise<SweepResult> => {
  if (sweepInFlight) {
    console.warn('[reclaim] previous sweep still in flight — skipping this tick');
    return emptyResult(true);
  }

  sweepInFlight = true;
  let totals: SweepResult;
  try {
    totals = await withCrossInstanceLock(drainSweep);
  } finally {
    sweepInFlight = false;
  }

  if (totals.errors > 0) {
    console.error('[reclaim] sweep completed WITH ERRORS — needs attention:', totals);
  } else if (totals.finalized > 0 || totals.released > 0) {
    console.log('[reclaim] sweep reclaimed/finalized holds:', totals);
  }
  return totals;
};

/**
 * Start the in-process periodic reclaim. Idempotent (returns the existing timer
 * if already started). Disabled when RESERVATION_RECLAIM_ENABLED=false — set
 * that when an external Cloud Scheduler drives /api/internal/reclaim-reservations
 * instead, so the two don't both sweep.
 *
 * Interval overridable via RESERVATION_RECLAIM_INTERVAL_MS (default 5 min).
 * The timer is unref()'d so it never keeps the process alive on its own.
 */
export const startReservationReclaimScheduler = (): NodeJS.Timeout | null => {
  if (timer) return timer;

  const enabled =
    (process.env.RESERVATION_RECLAIM_ENABLED ?? 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log(
      '[reclaim] in-process scheduler disabled (RESERVATION_RECLAIM_ENABLED=false)'
    );
    return null;
  }

  const intervalMs =
    Number.parseInt(process.env.RESERVATION_RECLAIM_INTERVAL_MS || '', 10) ||
    DEFAULT_INTERVAL_MS;

  timer = setInterval(() => {
    runReclaimSweep().catch((error) =>
      // A whole-sweep failure (e.g. the DB read failed): surface loudly, but
      // keep the interval alive so the next tick retries.
      console.error('[reclaim] scheduled sweep failed:', error)
    );
  }, intervalMs);
  timer.unref();

  // Kick off one sweep shortly after boot so a fresh deploy clears any backlog
  // without waiting a full interval. Detached + logged; never blocks startup.
  setTimeout(() => {
    runReclaimSweep().catch((error) =>
      console.error('[reclaim] startup sweep failed:', error)
    );
  }, 5_000).unref();

  console.log(
    `[reclaim] reservation reclaim scheduler started (every ${Math.round(
      intervalMs / 1000
    )}s, across all ticket types)`
  );
  return timer;
};

/** Stop the in-process scheduler (used on graceful shutdown / in tests). */
export const stopReservationReclaimScheduler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
