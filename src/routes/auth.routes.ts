import express from 'express';
import {
  requestOTPController,
  verifyOTPController,
  updateProfileController,
  getCurrentUserController,
  requestPasswordResetController,
  resetPasswordController,
  changePasswordController
} from '../controllers/auth.controller';
import {
  requestOTPValidator,
  verifyOTPValidator,
  updateProfileValidator,
  requestPasswordResetValidator,
  resetPasswordValidator
} from '../validators/auth.validator';
// Reuse the organizer change-password body validator (DRY) — the rules are
// identical for the scanner's /auth/change-password call.
import { changePasswordValidator } from '../validators/organizer.validator';
import { validate } from '../middleware/validate.middleware';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Public routes
router.post('/request-otp', validate(requestOTPValidator), requestOTPController);
router.post('/verify-otp', validate(verifyOTPValidator), verifyOTPController);

// Public password-recovery routes (organizer/staff email+password accounts).
router.post('/request-password-reset', validate(requestPasswordResetValidator), requestPasswordResetController);
router.post('/reset-password', validate(resetPasswordValidator), resetPasswordController);

// Protected routes
router.get('/me', protect, getCurrentUserController);
router.put('/profile', protect, validate(updateProfileValidator), updateProfileController);
router.post('/change-password', protect, validate(changePasswordValidator), changePasswordController);

export default router;
