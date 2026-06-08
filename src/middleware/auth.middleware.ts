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
 * Dashboard metrics access guard.
 *
 * Accepts EITHER:
 *  - an admin Bearer JWT (used by the admin dashboard frontend, which can't
 *    safely embed a static API key in browser JS), OR
 *  - the DASHBOARD_API_KEY via x-api-key (used by the server-to-server CEO
 *    dashboard integration).
 *
 * This is additive to verifyDashboardApiKey — neither path is removed.
 */
export const protectAdminOrApiKey = async (req: Request, res: Response, next: NextFunction) => {
  const authReq = req as AuthenticatedRequest;
  const authHeader = req.headers.authorization;

  // Path 1: admin Bearer JWT
  if (authHeader && authHeader.startsWith('Bearer')) {
    const token = authHeader.split(' ')[1];
    if (!token) {
      return next(new ApiError('Not authorized, no token provided', 401));
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
      if (user.role !== UserRole.ADMIN) {
        return next(new ApiError(`Role (${user.role}) is not authorized to access this resource`, 403));
      }
      authReq.user = user as unknown as IUser;
      return next();
    } catch (error) {
      return next(new ApiError('Not authorized, invalid token', 401));
    }
  }

  // Path 2: server-to-server API key
  return verifyDashboardApiKey(req, res, next);
};
