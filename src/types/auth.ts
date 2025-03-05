import { Request } from 'express';
import { IUser } from '../interfaces/user.interface';

/**
 * Extended Request interface that includes the authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: IUser;
} 