import express from 'express';
import { 
  createTicketTypeController,
  getTicketTypesController,
  updateTicketTypeController,
  deleteTicketTypeController,
  generateTicketsController,
  purchaseTicketController,
  getPaymentOptionsController,
  getUserTicketsController,
  verifyTicketController,
  getCheckInDetailsController,
  confirmCheckInController,
  getEventTicketsController,
  refundTicketController,
  cancelEventController
} from '../controllers/ticket.controller';
import {
  createTicketTypeValidator,
  updateTicketTypeValidator,
  generateTicketsValidator,
  purchaseTicketValidator,
  verifyTicketValidator,
  checkInLookupValidator,
  refundTicketValidator,
  cancelEventValidator
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
 * /api/tickets/payment-options:
 *   get:
 *     summary: List YeboPay payment options for the buyer
 *     tags: [Tickets]
 *     description: >
 *       Returns the active payment rails for a country (plus the buyer's saved
 *       methods) so the app can render the payment picker without hardcoding
 *       providers. Backed by YeboPay GET /v1/payment-options.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: country
 *         required: false
 *         schema:
 *           type: string
 *           example: SZ
 *         description: ISO country code (defaults to SZ)
 *     responses:
 *       200:
 *         description: Payment options and saved methods
 *       401:
 *         description: Not authenticated
 *       502:
 *         description: Payment options could not be loaded from YeboPay
 */
router.get('/payment-options', protect, getPaymentOptionsController);

/**
 * @swagger
 * /api/tickets/purchase/{ticketTypeId}:
 *   post:
 *     summary: Purchase an order of 1-10 tickets of a type in ONE payment (pays via YeboPay before issuing)
 *     tags: [Tickets]
 *     description: >
 *       Purchase `quantity` tickets (default 1, max 10) of the given type in a
 *       single order. The buyer must be authenticated. For a priced ticket the
 *       API reserves all `quantity` seats atomically (all-or-nothing) and
 *       charges the buyer via YeboPay ONCE for the whole order BEFORE issuing —
 *       a free ticket (price 0) needs no payment body. A buyer approves at most
 *       one mobile-money prompt no matter how many tickets they buy. Discover
 *       the available payment instruments via GET /api/tickets/payment-options.
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
 *       required: false
 *       description: >
 *         Payment instrument forwarded to YeboPay. Omit entirely for a free
 *         ticket; a PRICED ticket must carry either a saved paymentMethodId OR a
 *         providerCode (with phone for mobile money).
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentMethodId:
 *                 type: string
 *                 description: A saved YeboPay payment method id.
 *               providerCode:
 *                 type: string
 *                 description: A one-off rail code from /payment-options (e.g. a mobile-money provider).
 *               phone:
 *                 type: string
 *                 description: Subscriber MSISDN — required when providerCode is a mobile-money rail.
 *               country:
 *                 type: string
 *                 example: SZ
 *                 description: ISO 3166-1 alpha-2 country code (defaults to SZ).
 *               cardToken:
 *                 type: string
 *                 description: A tokenized card, when paying by card.
 *               idempotencyKey:
 *                 type: string
 *                 description: Fresh per order (not per ticket) so a retry never double-charges; auto-generated if omitted.
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 default: 1
 *                 description: How many tickets of this type to buy in one order (one charge for all of them).
 *     responses:
 *       201:
 *         description: >
 *           Synchronous payment SUCCEEDED — all `quantity` tickets issued, each
 *           with its scanner-ready QR, unique code, amountPaid and (shared)
 *           delivery status.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PurchaseTicketResponse'
 *       202:
 *         description: >
 *           Asynchronous charge (mobile money) is PENDING — all `quantity` seats
 *           are held (status 'reserved') and the tickets are issued
 *           automatically once YeboPay confirms via webhook. No QR yet.
 *       400:
 *         description: Invalid request or missing payment for a priced ticket
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
 *       409:
 *         description: Not enough tickets available to cover the requested quantity (none reserved)
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
 *       502:
 *         description: Payment could not be processed by YeboPay (no ticket issued)
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

/**
 * @swagger
 * /api/tickets/check-in-details:
 *   post:
 *     summary: Preview a scanned ticket (non-mutating)
 *     tags: [Tickets]
 *     description: >
 *       Look up a scanned ticket WITHOUT checking it in, returning the holder,
 *       event and current checked-in status so gate staff can confirm identity
 *       before committing. Only accessible by event organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [eventId, ticketId]
 *             properties:
 *               eventId:
 *                 type: string
 *               ticketId:
 *                 type: string
 *                 description: Ticket id (from the QR) or uniqueCode
 *     responses:
 *       200:
 *         description: Ticket details with a canCheckIn flag
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized
 */
router.post(
  '/check-in-details',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(checkInLookupValidator),
  getCheckInDetailsController
);

/**
 * @swagger
 * /api/tickets/confirm-check-in:
 *   post:
 *     summary: Commit a ticket check-in
 *     tags: [Tickets]
 *     description: >
 *       Mark a previewed ticket as checked in. Rejects when the ticket is
 *       unknown, not sold, or already checked in. Only accessible by event
 *       organizers and admins.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [eventId, ticketId]
 *             properties:
 *               eventId:
 *                 type: string
 *               ticketId:
 *                 type: string
 *                 description: Ticket id (from the QR) or uniqueCode
 *     responses:
 *       200:
 *         description: Check-in successful
 *       400:
 *         description: Ticket not sold or already checked in
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized
 *       404:
 *         description: Ticket not found
 */
router.post(
  '/confirm-check-in',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(checkInLookupValidator),
  confirmCheckInController
);

/**
 * @swagger
 * /api/tickets/event/{eventId}:
 *   get:
 *     summary: List an event's sold tickets for offline check-in caching
 *     tags: [Tickets]
 *     description: >
 *       Return the event's sold-ticket set so the gate scanner can pre-sync it
 *       and keep validating + checking attendees in when the venue network drops.
 *       Only sold tickets are returned (the set valid for check-in); each carries
 *       its current `isCheckedIn` state so the offline cache starts in sync.
 *       Scoped to the requesting organizer's own events (admins: any).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the event whose ticket set to cache
 *     responses:
 *       200:
 *         description: Sold-ticket set with a server sync timestamp
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not the owning organizer / not authorized
 *       404:
 *         description: Event not found
 */
router.get(
  '/event/:eventId',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  getEventTicketsController
);

/**
 * @swagger
 * /api/tickets/refund/{ticketId}:
 *   post:
 *     summary: Refund and cancel a single ticket
 *     tags: [Tickets]
 *     description: >
 *       Refund a sold ticket via YeboPay (against the stored charge ref) and mark
 *       it CANCELLED, notifying the holder. Idempotent: an already-cancelled
 *       ticket is a no-op. Only the owning organizer or an admin may refund. A
 *       failed YeboPay refund returns 502 and leaves the ticket unchanged (no
 *       false "refunded").
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: ticketId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the ticket to refund
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Optional reason recorded on the YeboPay refund
 *     responses:
 *       200:
 *         description: Refund outcome for the ticket
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not the owning organizer / not authorized
 *       404:
 *         description: Ticket not found
 *       502:
 *         description: YeboPay refund did not succeed (ticket left unchanged)
 */
router.post(
  '/refund/:ticketId',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(refundTicketValidator),
  refundTicketController
);

/**
 * @swagger
 * /api/tickets/events/{eventId}/cancel:
 *   post:
 *     summary: Cancel an event and refund all sold tickets
 *     tags: [Tickets]
 *     description: >
 *       Flag the event cancelled, then for every sold ticket issue a YeboPay
 *       refund against its stored charge ref, mark it CANCELLED and notify the
 *       holder. Idempotent + retryable: re-running only re-processes tickets not
 *       yet cancelled. Only the owning organizer or an admin may cancel. The
 *       response enumerates each ticket's outcome so refund/notify failures are
 *       surfaced rather than hidden.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: eventId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the event to cancel
 *     responses:
 *       200:
 *         description: Cancellation summary with per-ticket refund outcomes
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not the owning organizer / not authorized
 *       404:
 *         description: Event not found
 */
router.post(
  '/events/:eventId/cancel',
  protect,
  authorize(UserRole.ORGANIZER, UserRole.ADMIN),
  validate(cancelEventValidator),
  cancelEventController
);

export default router; 