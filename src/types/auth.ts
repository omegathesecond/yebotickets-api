import { Request } from 'express';

/**
 * User object attached to authenticated requests
 */
export interface AuthUser {
  id: string;
  name: string;
  phoneNumber: string;
  email?: string | null;
  role: string;
  isVerified: boolean;
}

/**
 * Extended Request interface that includes the authenticated user
 */
export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
