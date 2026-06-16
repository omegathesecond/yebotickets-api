import express from 'express';
import {
  requestOTPController,
  verifyOTPController,
  updateProfileController,
  getCurrentUserController,
  refreshTokenController
} from '../controllers/auth.controller';
import {
  requestOTPValidator,
  verifyOTPValidator,
  updateProfileValidator,
  refreshTokenValidator
} from '../validators/auth.validator';
import { validate } from '../middleware/validate.middleware';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Public routes
router.post('/request-otp', validate(requestOTPValidator), requestOTPController);
router.post('/verify-otp', validate(verifyOTPValidator), verifyOTPController);

/**
 * @swagger
 * /api/auth/refresh-token:
 *   post:
 *     summary: Exchange a refresh token for a new access token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access + refresh tokens
 *       401:
 *         description: Invalid or expired refresh token
 */
router.post('/refresh-token', validate(refreshTokenValidator), refreshTokenController);

// Protected routes
router.get('/me', protect, getCurrentUserController);
router.put('/profile', protect, validate(updateProfileValidator), updateProfileController);

export default router; 