import express from 'express';
import {
  requestOTPController,
  verifyOTPController,
  updateProfileController,
  getCurrentUserController,
  requestPasswordResetController,
  resetPasswordController,
  refreshTokenController
} from '../controllers/auth.controller';
import {
  requestOTPValidator,
  verifyOTPValidator,
  updateProfileValidator,
  requestPasswordResetValidator,
  resetPasswordValidator,
  refreshTokenValidator
} from '../validators/auth.validator';
import { validate } from '../middleware/validate.middleware';
import { protect } from '../middleware/auth.middleware';
import { requestOtpLimiter, verifyOtpLimiter } from '../middleware/rateLimit.middleware';

const router = express.Router();

// Public routes
// Rate limiters run BEFORE validation so abusive volume is rejected with 429
// before we touch the DB or fan out an SMS via YeboLink.
router.post('/request-otp', requestOtpLimiter, validate(requestOTPValidator), requestOTPController);
router.post('/verify-otp', verifyOtpLimiter, validate(verifyOTPValidator), verifyOTPController);

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

// Public password-recovery routes (organizer/staff email+password accounts).
router.post('/request-password-reset', validate(requestPasswordResetValidator), requestPasswordResetController);
router.post('/reset-password', validate(resetPasswordValidator), resetPasswordController);

// Protected routes.
// NOTE: change-password lives at POST /organizers/change-password (already
// present, protect + organizer/admin authorize) which is what the scanner
// calls — no duplicate is added here.
router.get('/me', protect, getCurrentUserController);
router.put('/profile', protect, validate(updateProfileValidator), updateProfileController);

export default router;
