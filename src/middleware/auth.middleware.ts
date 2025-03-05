import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ApiError } from './error.middleware';
import User from '../models/user.model';
import { IUser, UserRole } from '../interfaces/user.interface';

// No need for declaration here since it's in the types/express/index.d.ts file

export const protect = async (req: Request, res: Response, next: NextFunction) => {
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
      req.user = await User.findById(decoded.id).select('-password') as IUser;
      
      if (!req.user) {
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
    if (!req.user || !roles.includes(req.user.role as UserRole)) {
      return next(new ApiError(`Role (${req.user?.role}) is not authorized to access this resource`, 403));
    }
    next();
  };
}; 