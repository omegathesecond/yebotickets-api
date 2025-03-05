import { Document } from 'mongoose';

export enum UserRole {
  USER = 'user',
  ORGANIZER = 'organizer',
  ADMIN = 'admin'
}

// Interface for social media links
export interface ISocialMedia {
  facebook?: string;
  twitter?: string;
  instagram?: string;
  linkedin?: string;
}

// Interface for address
export interface IAddress {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

// Interface for organizer-specific fields
export interface IOrganizerProfile {
  companyName?: string;
  description?: string;
  website?: string;
  socialMedia?: ISocialMedia;
  address?: IAddress;
}

export interface IUser extends Document {
  name: string;
  phoneNumber: string;
  email?: string;
  password?: string;
  role: UserRole;
  isVerified: boolean;
  otp?: {
    code: string;
    expiresAt: Date;
  };
  // Organizer-specific fields
  organizerProfile?: IOrganizerProfile;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(enteredPassword: string): Promise<boolean>;
  generateAuthToken(): string;
  generateOTP(): string;
} 