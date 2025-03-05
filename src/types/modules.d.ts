// Express module enhancements
import express from 'express';
import { IUser } from '../interfaces/user.interface';

// Global type declarations
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}

// Add a generic declaration for all route files
declare module '*.routes' {
  const router: express.Router;
  export default router;
}

// Remove all the middleware and database module declarations 