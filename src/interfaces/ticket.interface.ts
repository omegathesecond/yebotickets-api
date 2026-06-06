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
  // Payment (set when sold via YeboPay; FREE for price-0 tickets)
  paymentRef?: string | null;
  paymentStatus?: string | null;
  amountPaid?: number | null;
  // Refund / cancellation outcome (set when refunded or its event is cancelled)
  refundRef?: string | null;
  refundedAt?: Date | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
