import { Document } from 'mongoose';
import { Types } from 'mongoose';

export interface IEvent extends Document {
  title: string;
  description: string;
  location: {
    address: string;
    city: string;
    country: string;
    coordinates?: {
      lat: number;
      lng: number;
    };
  };
  startDate: Date;
  endDate: Date;
  organizer: Types.ObjectId;
  isPublished: boolean;
  coverImage?: string;
  category: string;
  createdAt: Date;
  updatedAt: Date;
} 