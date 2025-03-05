import express from 'express';
import { 
  createTicketTypeController,
  getTicketTypesController,
  updateTicketTypeController,
  deleteTicketTypeController,
  generateTicketsController,
  purchaseTicketController,
  getUserTicketsController,
  verifyTicketController
} from '../controllers/ticket.controller';
import { 
  createTicketTypeValidator,
  updateTicketTypeValidator,
  generateTicketsValidator,
  purchaseTicketValidator,
  verifyTicketValidator
} from '../validators/ticket.validator';
import { validate } from '../middleware/validate.middleware';
import { protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';

const router = express.Router();

/**
 * @swagger
 * /api/tickets/types/event/{eventId}:
 *   get:
 *     summary: Get ticket types for an event
 *     tags: [Tickets]
 *     description: Retrieve all ticket types available for a specific event
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the event
 *     responses:
 *       200:
 *         description: List of ticket types for the event
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TicketTypesResponse'
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
router.get('/types/event/:eventId', getTicketTypesController);

/**
 * @swagger
 * /api/tickets/purchase/{ticketTypeId}:
 *   post:
 *     summary: Purchase a ticket
 *     tags: [Tickets]
 *     description: Purchase a ticket of a specific type. User must be authenticated.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketTypeId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the ticket type
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               quantity:
 *                 type: integer
 *                 example: 1
 *                 minimum: 1
 *                 description: Number of tickets to purchase
 *     responses:
 *       200:
 *         description: Ticket purchased successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PurchaseTicketResponse'
 *       400:
 *         description: Invalid request or insufficient tickets available
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
 *       404:
 *         description: Ticket type not found
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
  '/purchase/:ticketTypeId',
  protect,
  validate(purchaseTicketValidator),
  purchaseTicketController
);

/**
 * @swagger
 * /api/tickets/my-tickets:
 *   get:
 *     summary: Get current user's tickets
 *     tags: [Tickets]
 *     description: Retrieve all tickets purchased by the currently authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user's tickets
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TicketsResponse'
 *       401:
 *         description: Not authenticated
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
router.get(
  '/my-tickets',
  protect,
  getUserTicketsController
);

/**
 * @swagger
 * /api/tickets/types/event/{eventId}:
 *   post:
 *     summary: Create a ticket type for an event
 *     tags: [Tickets]
 *     description: Create a new ticket type for a specific event. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the event
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TicketTypeRequest'
 *     responses:
 *       201:
 *         description: Ticket type created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TicketTypeResponse'
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
router.post(
  '/types/event/:eventId',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(createTicketTypeValidator),
  createTicketTypeController
);

/**
 * @swagger
 * /api/tickets/types/{id}:
 *   put:
 *     summary: Update a ticket type
 *     tags: [Tickets]
 *     description: Update an existing ticket type. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the ticket type
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TicketTypeRequest'
 *     responses:
 *       200:
 *         description: Ticket type updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TicketTypeResponse'
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
 *         description: Ticket type not found
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
  '/types/:id',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(updateTicketTypeValidator),
  updateTicketTypeController
);

/**
 * @swagger
 * /api/tickets/types/{id}:
 *   delete:
 *     summary: Delete a ticket type
 *     tags: [Tickets]
 *     description: Delete an existing ticket type. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the ticket type
 *     responses:
 *       200:
 *         description: Ticket type deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Ticket type deleted successfully
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
 *         description: Ticket type not found
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
  '/types/:id',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  deleteTicketTypeController
);

/**
 * @swagger
 * /api/tickets/generate/{ticketTypeId}:
 *   post:
 *     summary: Generate tickets for a ticket type
 *     tags: [Tickets]
 *     description: Generate a batch of tickets for a specific ticket type. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketTypeId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the ticket type
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/GenerateTicketsRequest'
 *     responses:
 *       201:
 *         description: Tickets generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 count:
 *                   type: integer
 *                   example: 50
 *                 message:
 *                   type: string
 *                   example: 50 tickets generated successfully
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
 *         description: Ticket type not found
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
  '/generate/:ticketTypeId',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(generateTicketsValidator),
  generateTicketsController
);

/**
 * @swagger
 * /api/tickets/verify:
 *   post:
 *     summary: Verify and check in a ticket
 *     tags: [Tickets]
 *     description: Verify a ticket using its unique code and mark it as checked in. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerifyTicketRequest'
 *     responses:
 *       200:
 *         description: Ticket verified and checked in successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/VerifyTicketResponse'
 *       400:
 *         description: Invalid ticket code or ticket already checked in
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
 *         description: Ticket not found
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
  '/verify',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(verifyTicketValidator),
  verifyTicketController
);

export default router; 