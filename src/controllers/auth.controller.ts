import { Request, Response, NextFunction } from 'express';
import {
  requestOTP,
  verifyOTP,
  updateProfile,
  requestPasswordReset,
  resetPassword,
  changePassword
} from '../services/auth.service';
import { ApiError } from '../middleware/error.middleware';
import { IUser } from '../interfaces/user.interface';
import { AuthenticatedRequest } from '../types/auth';

export const requestOTPController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phoneNumber } = req.body;
    
    const result = await requestOTP(phoneNumber);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const verifyOTPController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phoneNumber, otp } = req.body;
    
    const result = await verifyOTP(phoneNumber, otp);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const updateProfileController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const userId = authReq.user.id;
    const updateData = req.body;
    
    const result = await updateProfile(userId, updateData);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getCurrentUserController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return next(new ApiError('User not authenticated', 401));
    }
    
    res.status(200).json({
      success: true,
      data: {
        user: authReq.user,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/request-password-reset
 * Issue a single-use, time-limited reset code for an organizer/staff account
 * (looked up by email) and deliver it via YeboLink. Public route.
 */
export const requestPasswordResetController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    const result = await requestPasswordReset(email);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/reset-password
 * Verify a reset code (unexpired, unused) and set a new password. Public route.
 */
export const resetPasswordController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, resetCode, newPassword } = req.body;
    await resetPassword(email, resetCode, newPassword);
    res.status(200).json({
      success: true,
      message: 'Password has been reset successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/change-password
 * Verify the caller's current password and set a new one. Protected route —
 * the user id comes from the auth middleware, never the request body.
 */
export const changePasswordController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const { currentPassword, newPassword } = req.body;
    await changePassword(authReq.user.id, currentPassword, newPassword);
    res.status(200).json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    next(error);
  }
};
