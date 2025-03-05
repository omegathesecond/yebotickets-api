import { Document, Types } from 'mongoose';

export enum TicketStatus {
  AVAILABLE = 'available',
  SOLD = 'sold',
  RESERVED = 'reserved',
  CANCELLED = 'cancelled'
}

export enum TicketType {
  STANDARD = 'standard',
  VIP = 'vip',
  EARLY_BIRD = 'early_bird',
  GROUP = 'group'
}

export interface ITicketType extends Document {
  name: string;
  description: string;
  price: number;
  quantity: number;
  eventId: Types.ObjectId;
  type: TicketType;
  saleStartDate: Date;
  saleEndDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITicket extends Document {
  ticketTypeId: Types.ObjectId;
  eventId: Types.ObjectId;
  userId?: Types.ObjectId;
  status: TicketStatus;
  purchaseDate?: Date;
  uniqueCode: string;
  isCheckedIn: boolean;
  checkedInAt?: Date;
  createdAt: Date;
  updatedAt: Date;
} 