import Event from '../models/event.model';
import { IEvent } from '../interfaces/event.interface';
import { ApiError } from '../middleware/error.middleware';
import { Types } from 'mongoose';

/**
 * Create a new event
 * @param eventData Event data
 * @param organizerId ID of the organizer creating the event
 * @returns Created event
 */
export const createEvent = async (eventData: Partial<IEvent>, organizerId: string): Promise<IEvent> => {
  try {
    const event = await Event.create({
      ...eventData,
      organizer: organizerId,
    });

    return event;
  } catch (error) {
    console.error('Error in createEvent service:', error);
    throw new ApiError('Failed to create event', 500);
  }
};

/**
 * Get all events with optional filtering
 * @param query Query parameters for filtering
 * @returns List of events
 */
export const getEvents = async (query: Record<string, any> = {}): Promise<IEvent[]> => {
  try {
    const filter: Record<string, any> = {};
    
    // Build filter based on query parameters
    if (query.category) filter.category = query.category;
    if (query.city) filter['location.city'] = query.city;
    if (query.country) filter['location.country'] = query.country;
    
    // Date filters
    if (query.startAfter) filter.startDate = { $gte: new Date(query.startAfter) };
    if (query.startBefore) {
      filter.startDate = { ...filter.startDate, $lte: new Date(query.startBefore) };
    }
    
    // By default, only return published events unless specified
    if (query.showUnpublished !== 'true') {
      filter.isPublished = true;
    }
    
    // Organizer filter
    if (query.organizer) {
      filter.organizer = new Types.ObjectId(query.organizer);
    }

    // Search by title or description
    if (query.search) {
      filter.$or = [
        { title: { $regex: query.search, $options: 'i' } },
        { description: { $regex: query.search, $options: 'i' } },
      ];
    }

    const events = await Event.find(filter)
      .populate('organizer', 'name email')
      .sort({ startDate: 1 })
      .limit(query.limit ? parseInt(query.limit) : 50);

    return events;
  } catch (error) {
    console.error('Error in getEvents service:', error);
    throw new ApiError('Failed to fetch events', 500);
  }
};

/**
 * Get event by ID
 * @param eventId Event ID
 * @returns Event details
 */
export const getEventById = async (eventId: string): Promise<IEvent> => {
  try {
    const event = await Event.findById(eventId)
      .populate('organizer', 'name email')
      .populate('ticketTypes');

    if (!event) {
      throw new ApiError('Event not found', 404);
    }

    return event;
  } catch (error) {
    console.error('Error in getEventById service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to fetch event details', 500);
  }
};

/**
 * Update event
 * @param eventId Event ID
 * @param updateData Data to update
 * @param organizerId ID of the organizer updating the event (for authorization)
 * @returns Updated event
 */
export const updateEvent = async (
  eventId: string,
  updateData: Partial<IEvent>,
  organizerId: string
): Promise<IEvent> => {
  try {
    // First check if the event exists and belongs to this organizer
    const event = await Event.findOne({
      _id: eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('Event not found or you do not have permission to update it', 404);
    }

    // Update the event
    Object.assign(event, updateData);
    await event.save();

    return event;
  } catch (error) {
    console.error('Error in updateEvent service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to update event', 500);
  }
};

/**
 * Delete event
 * @param eventId Event ID
 * @param organizerId ID of the organizer deleting the event (for authorization)
 * @returns Success message
 */
export const deleteEvent = async (
  eventId: string,
  organizerId: string
): Promise<{ message: string }> => {
  try {
    // Check if the event exists and belongs to this organizer
    const event = await Event.findOne({
      _id: eventId,
      organizer: organizerId,
    });

    if (!event) {
      throw new ApiError('Event not found or you do not have permission to delete it', 404);
    }

    // Delete the event
    await Event.deleteOne({ _id: eventId });

    return { message: 'Event deleted successfully' };
  } catch (error) {
    console.error('Error in deleteEvent service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to delete event', 500);
  }
}; 