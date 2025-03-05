import { IUser } from '../../interfaces/user.interface';

// This is the correct way to extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      user?: IUser;
    }
  }
}
