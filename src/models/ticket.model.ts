import mongoose, { Schema } from 'mongoose';
import { 
  ITicket, 
  ITicketType, 
  TicketStatus, 
  TicketType as TicketTypeEnum 
} from '../interfaces/ticket.interface';
import crypto from 'crypto';

// Ticket Type Schema (representing a class of tickets)
const TicketTypeSchema: Schema = new Schema({
  name: {
    type: String,
    required: [true, 'Please provide a ticket type name'],
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  price: {
    type: Number,
    required: [true, 'Please provide a price'],
    min: [0, 'Price cannot be negative'],
  },
  quantity: {
    type: Number,
    required: [true, 'Please provide a quantity'],
    min: [1, 'Quantity must be at least 1'],
  },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    required: [true, 'Ticket type must be associated with an event'],
  },
  type: {
    type: String,
    enum: Object.values(TicketTypeEnum),
    default: TicketTypeEnum.STANDARD,
  },
  saleStartDate: {
    type: Date,
    required: [true, 'Please provide a sale start date'],
  },
  saleEndDate: {
    type: Date,
    required: [true, 'Please provide a sale end date'],
    validate: {
      validator: function(this: ITicketType, value: Date) {
        return value >= this.saleStartDate;
      },
      message: 'Sale end date must be after sale start date',
    },
  },
}, {
  timestamps: true,
});

// Index for ticket type queries
TicketTypeSchema.index({ eventId: 1 });

// Individual Ticket Schema (representing a single ticket instance)
const TicketSchema: Schema = new Schema({
  ticketTypeId: {
    type: Schema.Types.ObjectId,
    ref: 'TicketType',
    required: [true, 'Ticket must be associated with a ticket type'],
  },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    required: [true, 'Ticket must be associated with an event'],
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  status: {
    type: String,
    enum: Object.values(TicketStatus),
    default: TicketStatus.AVAILABLE,
  },
  purchaseDate: {
    type: Date,
  },
  uniqueCode: {
    type: String,
    unique: true,
  },
  isCheckedIn: {
    type: Boolean,
    default: false,
  },
  checkedInAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

// Generate unique ticket code before saving
TicketSchema.pre<ITicket>('save', function(next) {
  if (!this.uniqueCode) {
    // Generate unique ticket code (random 10-character alphanumeric string)
    this.uniqueCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  }
  next();
});

// Indexes for common ticket queries
TicketSchema.index({ eventId: 1, status: 1 });
TicketSchema.index({ userId: 1 });
TicketSchema.index({ uniqueCode: 1 });

const TicketType = mongoose.model<ITicketType>('TicketType', TicketTypeSchema);
const Ticket = mongoose.model<ITicket>('Ticket', TicketSchema);

export { TicketType, Ticket }; 