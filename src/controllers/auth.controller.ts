import { Request, Response, NextFunction } from 'express';
import { 
  requestOTP, 
  verifyOTP, 
  updateProfile
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
    if (!authReq.user || !authReq.user._id) {
      return next(new ApiError('User not authenticated', 401));
    }

    const userId = authReq.user._id.toString();
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
