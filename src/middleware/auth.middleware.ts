import { Request, Response, NextFunction } from 'express';
import { ApiError } from './error.middleware';
import prisma from '../config/prisma';
import { IUser, UserRole } from '../interfaces/user.interface';
import { AuthenticatedRequest } from '../types/auth';
import { verifyAccessToken } from '../services/token.service';

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
      const decoded = verifyAccessToken(token);

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

/**
 * Guard for internal machine-to-machine endpoints (e.g. the Cloud Scheduler
 * driven reservation-reclaim sweep). Authenticates the `x-internal-key` header
 * against INTERNAL_API_KEY.
 *
 * Fails CLOSED: if INTERNAL_API_KEY is not configured the endpoint is rejected
 * with 503 rather than silently accepting every caller — a misconfiguration is
 * surfaced loudly, never treated as "open" (CLAUDE.md: no silent fallbacks).
 */
export const verifyInternalApiKey = (req: Request, res: Response, next: NextFunction) => {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    return next(new ApiError('Internal API key not configured', 503));
  }

  const apiKey = req.headers['x-internal-key'] || req.query.internalKey;
  if (!apiKey) {
    return next(new ApiError('Internal API key required', 401));
  }
  if (apiKey !== expected) {
    return next(new ApiError('Invalid internal API key', 401));
  }

  next();
};
