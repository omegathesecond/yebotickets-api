import express from 'express';
import { getUserEventsController } from '../controllers/organizer-event.controller';
import { protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';

const router = express.Router();

/**
 * @swagger
 * /api/user/events:
 *   get:
 *     summary: Get the logged-in organizer's own events
 *     tags: [User]
 *     description: >
 *       Canonical path for the organizer dashboard's event list. Returns the
 *       caller's own events only (organizers and admins alike see their own).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Array of the organizer's events
 */
router.get('/events', protect, authorize(UserRole.ORGANIZER, UserRole.ADMIN), getUserEventsController);

export default router;
