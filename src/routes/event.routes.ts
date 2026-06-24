import express from 'express';
import { 
  createEventController,
  getEventsController,
  getEventByIdController,
  updateEventController,
  deleteEventController
} from '../controllers/event.controller';
import { 
  createEventValidator,
  updateEventValidator
} from '../validators/event.validator';
import {
  getEarningsController,
  getEventDetailsController,
  getEventPurchasesController,
  getEventTicketsController,
} from '../controllers/organizer-event.controller';
import { validate } from '../middleware/validate.middleware';
import { protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';

const router = express.Router();

/**
 * @swagger
 * /api/events/earnings:
 *   get:
 *     summary: Get the logged-in organizer's earnings
 *     tags: [Events]
 *     description: >
 *       Total + per-event earnings derived from the organizer's real SOLD
 *       tickets. MUST be declared before GET /:id so 'earnings' is not captured
 *       as an event id.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Earnings summary
 */
router.get(
  '/earnings',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  getEarningsController
);

/**
 * @swagger
 * /api/events:
 *   get:
 *     summary: Get all events
 *     tags: [Events]
 *     description: Retrieve a list of all published events. Can be filtered by query parameters.
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for event title or description
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by event category
 *       - in: query
 *         name: city
 *         schema:
 *           type: string
 *         description: Filter by event city
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter events starting from this date
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of events per page
 *     responses:
 *       200:
 *         description: A list of events
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventsResponse'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', getEventsController);

/**
 * @swagger
 * /api/events/{id}:
 *   get:
 *     summary: Get event by ID
 *     tags: [Events]
 *     description: Retrieve detailed information about a specific event by its ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The event ID
 *     responses:
 *       200:
 *         description: Detailed event information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventResponse'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', getEventByIdController);

/**
 * @swagger
 * /api/events/{id}/details:
 *   get:
 *     summary: Get organizer-facing stats for one event
 *     tags: [Events]
 *     description: >
 *       Event plus computed stats (total revenue, tickets sold, pending
 *       payments, per-ticket-type breakdown) for an event the caller owns.
 *       Organizers may only read their own events; admins any.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Event details with stats
 *       403:
 *         description: Not the owner of this event
 *       404:
 *         description: Event not found
 */
router.get(
  '/:id/details',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  getEventDetailsController
);

/**
 * @swagger
 * /api/events/{id}/purchases:
 *   get:
 *     summary: Paginated purchase history for one event (owner only)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Paginated purchases
 */
router.get(
  '/:id/purchases',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  getEventPurchasesController
);

/**
 * @swagger
 * /api/events/{id}/tickets:
 *   get:
 *     summary: Paginated issued-ticket list for one event (owner only)
 *     tags: [Events]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Paginated tickets
 */
router.get(
  '/:id/tickets',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  getEventTicketsController
);

/**
 * @swagger
 * /api/events:
 *   post:
 *     summary: Create a new event
 *     tags: [Events]
 *     description: Create a new event. Only accessible by organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EventRequest'
 *     responses:
 *       201:
 *         description: Event created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventResponse'
 *       400:
 *         description: Invalid request data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post(
  '/', 
  protect, 
  authorize(UserRole.ORGANIZER, UserRole.ADMIN), 
  validate(createEventValidator), 
  createEventController
);

/**
 * @swagger
 * /api/events/{id}:
 *   put:
 *     summary: Update an event
 *     tags: [Events]
 *     description: Update an existing event. Only accessible by the organizer who created the event or by admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The event ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EventRequest'
 *     responses:
 *       200:
 *         description: Event updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventResponse'
 *       400:
 *         description: Invalid request data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put(
  '/:id', 
  protect, 
  authorize(UserRole.ORGANIZER, UserRole.ADMIN), 
  validate(updateEventValidator), 
  updateEventController
);

/**
 * @swagger
 * /api/events/{id}:
 *   delete:
 *     summary: Delete an event
 *     tags: [Events]
 *     description: Delete an existing event. Only accessible by the organizer who created the event or by admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The event ID
 *     responses:
 *       200:
 *         description: Event deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                 message:
 *                   type: string
 *                   example: Event deleted successfully
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Event not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete(
  '/:id', 
  protect, 
  authorize(UserRole.ORGANIZER, UserRole.ADMIN), 
  deleteEventController
);

export default router; 