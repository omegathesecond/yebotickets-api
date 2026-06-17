import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from './error.middleware';
import prisma from '../config/prisma';
import { IUser, UserRole } from '../interfaces/user.interface';
import { AuthenticatedRequest } from '../types/auth';

// Create a custom request interface with the user property
export interface AuthRequest extends Request {
  user: IUser;
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  // Cast req to AuthenticatedRequest to allow user property
  const authReq = req as AuthenticatedRequest;
  try {
    let token;

    // Check if auth header exists and starts with Bearer
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new ApiError('Not authorized, no token provided', 401));
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string };

      // Get user from database
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          name: true,
          phoneNumber: true,
          email: true,
          role: true,
          isVerified: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      
      if (!user) {
        return next(new ApiError('User not found', 404));
      }

      // Attach user to request object
      authReq.user = user as unknown as IUser;

      next();
    } catch (error) {
      return next(new ApiError('Not authorized, invalid token', 401));
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Optional authentication for public endpoints that expose extra data to
 * privileged callers (e.g. admins can list unpublished events).
 *
 * Behaviour:
 *  - No token               -> continue as anonymous (req.user undefined).
 *  - Valid token            -> attach req.user.
 *  - Token present, invalid -> 401 (so a stale admin session still triggers
 *                              re-login instead of silently downgrading).
 *
 * Never fabricates a user. Downstream handlers must treat a missing req.user
 * as an unauthenticated/public request.
 */
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthenticatedRequest;

  // No bearer token -> anonymous request, proceed without a user.
  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer')) {
    return next();
  }

  const token = req.headers.authorization.split(' ')[1];
  if (!token) {
    return next(new ApiError('Not authorized, invalid token', 401));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as { id: string };
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      return next(new ApiError('User not found', 404));
    }

    authReq.user = user as unknown as IUser;
    next();
  } catch (error) {
    return next(new ApiError('Not authorized, invalid token', 401));
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !roles.includes(authReq.user.role as UserRole)) {
      return next(new ApiError(`Role (${authReq.user?.role}) is not authorized to access this resource`, 403));
    }
    next();
  };
};

/**
 * Middleware to verify API key for dashboard access
 */
export const verifyDashboardApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey) {
    return next(new ApiError('API key required', 401));
  }
  
  if (apiKey !== process.env.DASHBOARD_API_KEY) {
    return next(new ApiError('Invalid API key', 401));
  }
  
  next();
};
