import { IUser } from '../../interfaces/user.interface';

// Declare the namespace globally to ensure it's recognized across the application
declare global {
  namespace Express {
    interface Request {
      user: IUser;
    }
  }
}
