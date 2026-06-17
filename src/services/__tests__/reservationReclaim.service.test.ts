// Unit tests for the global reclaim sweep + in-process scheduler.
//
// We mock ../ticket.service so these tests exercise ONLY the orchestration
// (batch draining, progress guard, overlap guard, error surfacing, timer
// wiring) — the per-row reclaim logic (and its idempotency under guarded
// updateMany) is covered by ticket.service.test.ts.

jest.mock('../ticket.service', () => ({
  __esModule: true,
  RECLAIM_BATCH: 20,
  reclaimExpiredReservations: jest.fn(),
}));

import { reclaimExpiredReservations, RECLAIM_BATCH } from '../ticket.service';
import {
  runReclaimSweep,
  startReservationReclaimScheduler,
  stopReservationReclaimScheduler,
} from '../reservationReclaim.service';

const reclaimMock = reclaimExpiredReservations as jest.MockedFunction<
  typeof reclaimExpiredReservations
>;

const summary = (over: Partial<Record<string, number>> = {}) => ({
  scanned: 0,
  finalized: 0,
  released: 0,
  stillPending: 0,
  errors: 0,
  ...over,
});

afterEach(() => {
  stopReservationReclaimScheduler();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('runReclaimSweep', () => {
  it('runs the reclaim GLOBALLY (no ticketTypeId) so every ticket type is swept', async () => {
    reclaimMock.mockResolvedValueOnce(summary({ scanned: 3, released: 2 }) as any);

    const result = await runReclaimSweep();

    expect(reclaimMock).toHaveBeenCalledTimes(1);
    expect(reclaimMock).toHaveBeenCalledWith(); // no argument => all ticket types
    expect(result).toMatchObject({ scanned: 3, released: 2, iterations: 1, skipped: false });
  });

  it('drains successive FULL batches while each makes progress, then stops on a partial batch', async () => {
    reclaimMock
      .mockResolvedValueOnce(summary({ scanned: RECLAIM_BATCH, released: 20 }) as any) // full + progress -> continue
      .mockResolvedValueOnce(summary({ scanned: RECLAIM_BATCH, finalized: 20 }) as any) // full + progress -> continue
      .mockResolvedValueOnce(summary({ scanned: 5, released: 5 }) as any); // partial -> stop

    const result = await runReclaimSweep();

    expect(reclaimMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      scanned: RECLAIM_BATCH * 2 + 5,
      released: 25,
      finalized: 20,
      iterations: 3,
    });
  });

  it('STOPS after one full batch that made no progress (all still-pending) — never spins forever', async () => {
    // A full batch of holds still within the hard-expiry window: nothing freed.
    // Re-fetching would return the same rows, so the loop must halt immediately.
    reclaimMock.mockResolvedValue(summary({ scanned: RECLAIM_BATCH, stillPending: RECLAIM_BATCH }) as any);

    const result = await runReclaimSweep();

    expect(reclaimMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ iterations: 1, stillPending: RECLAIM_BATCH });
  });

  it('aggregates per-row errors and surfaces them loudly (logged at error level)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    reclaimMock.mockResolvedValueOnce(summary({ scanned: 2, errors: 2 }) as any);

    const result = await runReclaimSweep();

    expect(result).toMatchObject({ errors: 2 });
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('WITH ERRORS'),
      expect.objectContaining({ errors: 2 })
    );
    errSpy.mockRestore();
  });

  it('propagates a catastrophic failure (e.g. DB read) rather than swallowing it', async () => {
    reclaimMock.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(runReclaimSweep()).rejects.toThrow('database unreachable');
  });

  it('skips (does not double-run) while a previous sweep is still in flight', async () => {
    let release!: (v: any) => void;
    reclaimMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as any
    );

    const first = runReclaimSweep(); // starts, hangs on the unresolved reclaim
    const second = await runReclaimSweep(); // concurrent -> must skip

    expect(second).toMatchObject({ skipped: true, iterations: 0 });
    expect(reclaimMock).toHaveBeenCalledTimes(1);

    release(summary({ scanned: 1, released: 1 }));
    await expect(first).resolves.toMatchObject({ skipped: false, iterations: 1 });
  });

  it('frees the in-flight lock after completion so the next sweep runs', async () => {
    reclaimMock.mockResolvedValue(summary({ scanned: 0 }) as any);

    await runReclaimSweep();
    const second = await runReclaimSweep();

    expect(second.skipped).toBe(false);
    expect(reclaimMock).toHaveBeenCalledTimes(2);
  });
});

describe('startReservationReclaimScheduler', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('does not start when RESERVATION_RECLAIM_ENABLED=false', () => {
    process.env.RESERVATION_RECLAIM_ENABLED = 'false';
    const timer = startReservationReclaimScheduler();
    expect(timer).toBeNull();
  });

  it('fires a global sweep on the configured interval', async () => {
    jest.useFakeTimers();
    process.env.RESERVATION_RECLAIM_ENABLED = 'true';
    process.env.RESERVATION_RECLAIM_INTERVAL_MS = '300000';
    reclaimMock.mockResolvedValue(summary({ scanned: 0 }) as any);

    const timer = startReservationReclaimScheduler();
    expect(timer).not.toBeNull();

    // The startup kick (5s) plus one full interval (300s) each trigger a sweep.
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(300_000);

    expect(reclaimMock).toHaveBeenCalled();
  });

  it('is idempotent — a second start returns the same timer without a new interval', () => {
    process.env.RESERVATION_RECLAIM_ENABLED = 'true';
    const first = startReservationReclaimScheduler();
    const second = startReservationReclaimScheduler();
    expect(second).toBe(first);
  });
});
