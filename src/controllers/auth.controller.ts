import { Request, Response, NextFunction } from 'express';
import { 
  requestOTP, 
  verifyOTP, 
  updateProfile
} from '../services/auth.service';
import { ApiError } from '../middleware/error.middleware';
import { IUser } from '../interfaces/user.interface';
import { AuthenticatedRequest } from '../types/auth';
import prisma from '../config/prisma';
import { verifyRefreshToken, generateAuthTokens } from '../services/token.service';

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

/**
 * POST /api/auth/refresh-token
 * Exchange a valid refresh token for a fresh access token (and a rotated refresh
 * token). Responds with the BARE `{ accessToken, refreshToken }` body the
 * customer-dashboard's axios refresh interceptor reads (response.data.accessToken),
 * NOT the `{ success, data }` envelope. Fails loudly (401) on a missing/expired/
 * non-refresh token — never silently issues a token for an invalid one.
 */
export const refreshTokenController = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    // Throws a 401 ApiError if the token is invalid/expired or not a refresh token.
    const payload = verifyRefreshToken(refreshToken);

    // Confirm the user still exists (token could outlive a deleted account).
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, role: true },
    });
    if (!user) {
      return next(new ApiError('User no longer exists', 401));
    }

    const tokens = generateAuthTokens(user.id, user.role);

    res.status(200).json({
      accessToken: tokens.token,
      refreshToken: tokens.refreshToken,
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
