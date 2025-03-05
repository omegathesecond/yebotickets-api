import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from './error.middleware';
import User from '../models/user.model';
import { IUser, UserRole } from '../interfaces/user.interface';

// Create a custom request interface with the user property
export interface AuthRequest extends Request {
  user: IUser;
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  // Cast req to AuthRequest to allow user property
  const authReq = req as AuthRequest;
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

      // Attach user to request object
      authReq.user = await User.findById(decoded.id).select('-password') as IUser;
      
      if (!authReq.user) {
        return next(new ApiError('User not found', 404));
      }

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
    const authReq = req as AuthRequest;
    if (!authReq.user || !roles.includes(authReq.user.role as UserRole)) {
      return next(new ApiError(`Role (${authReq.user?.role}) is not authorized to access this resource`, 403));
    }
    next();
  };
}; 
