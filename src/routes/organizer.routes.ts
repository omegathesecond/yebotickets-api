/**
 * @swagger
 * tags:
 *   name: Organizers
 *   description: Organizer management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Organizer:
 *       type: object
 *       required:
 *         - name
 *         - phoneNumber
 *         - role
 *       properties:
 *         _id:
 *           type: string
 *           description: Auto-generated ID
 *         name:
 *           type: string
 *           description: Organizer's full name
 *         phoneNumber:
 *           type: string
 *           description: Organizer's phone number
 *         email:
 *           type: string
 *           format: email
 *           description: Organizer's email address
 *         role:
 *           type: string
 *           enum: [organizer, admin]
 *           description: User role
 *         isVerified:
 *           type: boolean
 *           description: Whether the phone number is verified
 *         organizerProfile:
 *           type: object
 *           properties:
 *             companyName:
 *               type: string
 *             description:
 *               type: string
 *             website:
 *               type: string
 *             socialMedia:
 *               type: object
 *               properties:
 *                 facebook:
 *                   type: string
 *                 twitter:
 *                   type: string
 *                 instagram:
 *                   type: string
 *             address:
 *               type: object
 *               properties:
 *                 street:
 *                   type: string
 *                 city:
 *                   type: string
 *                 state:
 *                   type: string
 *                 zipCode:
 *                   type: string
 *                 country:
 *                   type: string
 */

import express, { Request, Response, NextFunction } from 'express';
import { getEventsController, createEventController } from '../controllers/event.controller';
import { protect, authorize } from '../middleware/auth.middleware';
import { UserRole } from '../interfaces/user.interface';
import { AuthenticatedRequest } from '../types/auth';
import { 
  becomeOrganizerController, 
  updateOrganizerProfileController,
  getOrganizerProfileController,
  getOrganizerDashboardController,
  getOrganizersController,
  loginOrganizerController,
  updateOrganizerStatusController,
  deleteOrganizerController,
  changePasswordController
} from '../controllers/organizer.controller';
import { validate } from '../middleware/validate.middleware';
import {
  organizerProfileValidator,
  organizerSignupValidator,
  organizerLoginValidator,
  organizerStatusValidator,
  changePasswordValidator
} from '../validators/organizer.validator';

const router = express.Router();

/**
 * @swagger
 * /organizers/signup:
 *   post:
 *     summary: Register as an organizer
 *     tags: [Organizers]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - phoneNumber
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *               phoneNumber:
 *                 type: string
 *               password:
 *                 type: string
 *               email:
 *                 type: string
 *               organizerProfile:
 *                 $ref: '#/components/schemas/Organizer/properties/organizerProfile'
 *     responses:
 *       200:
 *         description: Organizer created successfully
 *       400:
 *         description: Invalid input data
 */
router.post('/signup', validate(organizerSignupValidator), becomeOrganizerController);

/**
 * @swagger
 * /organizers/login:
 *   post:
 *     summary: Login as an organizer
 *     tags: [Organizers]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phoneNumber:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *             oneOf:
 *               - required: [phoneNumber, password]
 *               - required: [email, password]
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', validate(organizerLoginValidator), loginOrganizerController);

// Protected routes
router.use(protect);

/**
 * @swagger
 * /organizers/all:
 *   get:
 *     summary: Get all organizers (Admin only)
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all organizers
 *       403:
 *         description: Admin access required
 */
router.get('/all', authorize(UserRole.ADMIN), getOrganizersController);

/**
 * @swagger
 * /organizers/{id}/status:
 *   put:
 *     summary: Update organizer status (Admin only)
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isVerified:
 *                 type: boolean
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Organizer status updated
 *       403:
 *         description: Admin access required
 */
router.put('/:id/status', authorize(UserRole.ADMIN), validate(organizerStatusValidator), updateOrganizerStatusController);

/**
 * @swagger
 * /organizers/{id}:
 *   delete:
 *     summary: Delete an organizer (Admin only)
 *     tags: [Organizers]
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
 *         description: Organizer deleted successfully
 *       403:
 *         description: Admin access required
 */
router.delete('/:id', authorize(UserRole.ADMIN), deleteOrganizerController);

// Routes accessible by both admin and organizer
router.use(authorize(UserRole.ORGANIZER, UserRole.ADMIN));

/**
 * @swagger
 * /organizers/profile:
 *   get:
 *     summary: Get organizer profile
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Organizer profile data
 *   put:
 *     summary: Update organizer profile
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Organizer'
 *     responses:
 *       200:
 *         description: Profile updated successfully
 */
router.get('/profile', getOrganizerProfileController);
router.put('/profile', validate(organizerProfileValidator), updateOrganizerProfileController);

/**
 * @swagger
 * /organizers/change-password:
 *   post:
 *     summary: Change the authenticated organizer's password
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password updated successfully
 *       401:
 *         description: Current password is incorrect
 */
router.post('/change-password', validate(changePasswordValidator), changePasswordController);

/**
 * @swagger
 * /organizers/dashboard:
 *   get:
 *     summary: Get organizer dashboard data
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data including events and statistics
 */
router.get('/dashboard', getOrganizerDashboardController);

/**
 * @swagger
 * /organizers/events:
 *   get:
 *     summary: Get organizer events
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: organizer
 *         schema:
 *           type: string
 *         description: Filter by organizer ID (admin only)
 *     responses:
 *       200:
 *         description: List of events
 *   post:
 *     summary: Create a new event
 *     tags: [Organizers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Event'
 *     responses:
 *       201:
 *         description: Event created successfully
 */
router.get('/events', (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user && authReq.user.id) {
    // If admin, allow viewing all events unless organizer ID is specified
    if (authReq.user.role === UserRole.ADMIN && !req.query.organizer) {
      next();
      return;
    }
    // For organizers or when organizer ID is specified
    req.query = {
      ...req.query,
      organizer: (req.query.organizer as string) || authReq.user.id,
      showUnpublished: 'true'
    };
  }
  next();
}, getEventsController);

router.post('/events', createEventController);

export default router; 