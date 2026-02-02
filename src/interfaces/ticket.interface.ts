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

export interface ITicketType {
  id: string;
  name: string;
  description: string | null;
  price: number;
  quantity: number;
  eventId: string;
  type: TicketType;
  saleStartDate: Date;
  saleEndDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITicket {
  id: string;
  ticketTypeId: string;
  eventId: string;
  userId?: string | null;
  status: TicketStatus;
  purchaseDate?: Date | null;
  uniqueCode: string;
  isCheckedIn: boolean;
  checkedInAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
