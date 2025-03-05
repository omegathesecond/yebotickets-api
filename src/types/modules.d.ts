// Express module enhancements
import express from 'express';
// Import for IUser is in express/index.d.ts

// Add a generic declaration for all route files
declare module '*.routes' {
  const router: express.Router;
  export default router;
}

// Remove all the middleware and database module declarations 
