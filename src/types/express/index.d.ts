import { IUser } from '../../interfaces/user.interface';

declare namespace Express {
  export interface Request {
    user: IUser;
  }
}
