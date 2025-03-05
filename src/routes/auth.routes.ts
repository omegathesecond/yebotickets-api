import express from 'express';
import { 
  requestOTPController, 
  verifyOTPController, 
  updateProfileController,
  getCurrentUserController
} from '../controllers/auth.controller';
import { 
  requestOTPValidator, 
  verifyOTPValidator, 
  updateProfileValidator 
} from '../validators/auth.validator';
import { validate } from '../middleware/validate.middleware';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Public routes
router.post('/request-otp', validate(requestOTPValidator), requestOTPController);
router.post('/verify-otp', validate(verifyOTPValidator), verifyOTPController);

// Protected routes
router.get('/me', protect, getCurrentUserController);
router.put('/profile', protect, validate(updateProfileValidator), updateProfileController);

export default router; 