import { Router, Request, Response, NextFunction } from 'express';
import { verifyInternalApiKey } from '../middleware/auth.middleware';
import { runReclaimSweep } from '../services/reservationReclaim.service';

const router = Router();

/**
 * @swagger
 * /api/internal/reclaim-reservations:
 *   post:
 *     summary: Run the global expired-reservation reclaim sweep (server-to-server)
 *     description: >
 *       Drives reclaimExpiredReservations() across ALL ticket types, freeing
 *       seats held by abandoned/expired PENDING reservations and reconciling any
 *       missed YeboPay settlement. Intended for a Cloud Scheduler job (~every
 *       5 min); the API also runs this in-process by default. Idempotent and
 *       safe to retry. Authenticated with INTERNAL_API_KEY (x-internal-key).
 *     tags: [Internal]
 *     security:
 *       - InternalKeyAuth: []
 *     responses:
 *       200:
 *         description: Sweep tally (scanned/finalized/released/stillPending/errors/iterations)
 *       401:
 *         description: Missing or invalid internal API key
 *       503:
 *         description: Internal API key not configured
 */
router.post(
  '/reclaim-reservations',
  verifyInternalApiKey,
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const summary = await runReclaimSweep();
      res.status(200).json({ success: true, summary });
    } catch (error) {
      // A whole-sweep failure (e.g. the DB read failed) is surfaced as a 5xx so
      // the scheduler's run is marked failed — never a fake "ok" (CLAUDE.md).
      next(error);
    }
  }
);

export default router;
