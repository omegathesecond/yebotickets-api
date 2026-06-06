import { Router, Request, Response, NextFunction } from 'express';
import { verifyDashboardApiKey, protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';
import { getDashboardMetrics } from '../services/dashboard.service';

const router = Router();

/**
 * @swagger
 * /api/dashboard/metrics:
 *   get:
 *     summary: Get dashboard metrics for CEO dashboard (server-to-server, API key)
 *     tags: [Dashboard]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics
 */
router.get('/metrics', verifyDashboardApiKey, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getDashboardMetrics();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/dashboard/admin/metrics:
 *   get:
 *     summary: Get platform metrics for the YeboTickets admin dashboard (ADMIN JWT)
 *     description: >
 *       Same metrics as /metrics but authenticated with an ADMIN bearer token instead
 *       of the shared dashboard API key, so the browser-based admin dashboard never
 *       has to embed a secret in its bundle.
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics
 *       403:
 *         description: Admin access required
 */
router.get('/admin/metrics', protect, authorize(UserRole.ADMIN), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await getDashboardMetrics();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

export default router;
