import mongoose, { Schema } from 'mongoose';
import { IEvent } from '../interfaces/event.interface';

const EventSchema: Schema = new Schema({
  title: {
    type: String,
    required: [true, 'Please provide an event title'],
    trim: true,
    maxlength: [100, 'Event title cannot exceed 100 characters'],
  },
  description: {
    type: String,
    required: [true, 'Please provide an event description'],
    trim: true,
  },
  location: {
    address: {
      type: String,
      required: [true, 'Please provide an address'],
    },
    city: {
      type: String,
      required: [true, 'Please provide a city'],
    },
    country: {
      type: String,
      required: [true, 'Please provide a country'],
    },
    coordinates: {
      lat: Number,
      lng: Number,
    },
  },
  startDate: {
    type: Date,
    required: [true, 'Please provide a start date'],
  },
  endDate: {
    type: Date,
    required: [true, 'Please provide an end date'],
    validate: {
      validator: function(this: IEvent, value: Date) {
        return value >= this.startDate;
      },
      message: 'End date must be after start date',
    },
  },
  organizer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Event must have an organizer'],
  },
  isPublished: {
    type: Boolean,
    default: false,
  },
  coverImage: {
    type: String,
  },
  category: {
    type: String,
    required: [true, 'Please provide an event category'],
    trim: true,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for ticket types associated with this event
EventSchema.virtual('ticketTypes', {
  ref: 'TicketType',
  localField: '_id',
  foreignField: 'eventId',
});

// Index for search performance
EventSchema.index({ title: 'text', description: 'text' });
EventSchema.index({ 'location.city': 1, 'location.country': 1 });
EventSchema.index({ startDate: 1, endDate: 1 });
EventSchema.index({ organizer: 1 });

export default mongoose.model<IEvent>('Event', EventSchema);