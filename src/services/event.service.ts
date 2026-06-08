import prisma from '../config/prisma';
import { IEvent, IEventInput, flattenEventLocation, nestEventLocation } from '../interfaces/event.interface';
import { ApiError } from '../middleware/error.middleware';

/**
 * Transform Prisma event to API response format
 */
const transformEvent = (event: any) => ({
  id: event.id,
  title: event.title,
  description: event.description,
  location: nestEventLocation(event),
  startDate: event.startDate,
  endDate: event.endDate,
  organizer: event.organizer ? {
    id: event.organizer.id,
    name: event.organizer.name,
    email: event.organizer.email,
  } : { id: event.organizerId },
  isPublished: event.isPublished,
  coverImage: event.coverImage,
  category: event.category,
  ticketTypes: event.ticketTypes || [],
  createdAt: event.createdAt,
  updatedAt: event.updatedAt,
});

/**
 * Create a new event
 * @param eventData Event data
 * @param organizerId ID of the organizer creating the event
 * @returns Created event
 */
export const createEvent = async (eventData: IEventInput, organizerId: string) => {
  try {
    const event = await prisma.event.create({
      data: {
        title: eventData.title,
        description: eventData.description,
        ...flattenEventLocation(eventData.location),
        startDate: new Date(eventData.startDate),
        endDate: new Date(eventData.endDate),
        organizerId,
        isPublished: eventData.isPublished || false,
        coverImage: eventData.coverImage || null,
        category: eventData.category,
      },
      include: {
        organizer: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return transformEvent(event);
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
export const getEvents = async (query: Record<string, any> = {}) => {
  try {
    const where: any = {};
    
    // Build filter based on query parameters
    if (query.category) where.category = query.category;
    if (query.city) where.locationCity = query.city;
    if (query.country) where.locationCountry = query.country;
    
    // Date filters
    if (query.startAfter) {
      where.startDate = { gte: new Date(query.startAfter) };
    }
    if (query.startBefore) {
      where.startDate = {
        ...where.startDate,
        lte: new Date(query.startBefore),
      };
    }
    
    // By default, only return published events unless specified
    if (query.showUnpublished !== 'true') {
      where.isPublished = true;
    }
    
    // Organizer filter
    if (query.organizer) {
      where.organizerId = query.organizer;
    }

    // Search by title or description
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const events = await prisma.event.findMany({
      where,
      include: {
        organizer: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { startDate: 'asc' },
      take: query.limit ? parseInt(query.limit) : 50,
    });

    return events.map(transformEvent);
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
export const getEventById = async (eventId: string) => {
  try {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        organizer: {
          select: { id: true, name: true, email: true },
        },
        ticketTypes: true,
      },
    });

    if (!event) {
      throw new ApiError('Event not found', 404);
    }

    return transformEvent(event);
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
  updateData: Partial<IEventInput>,
  organizerId: string,
  isAdmin = false
) => {
  try {
    // Admins can moderate any event; organizers are scoped to their own.
    const existingEvent = await prisma.event.findFirst({
      where: isAdmin ? { id: eventId } : { id: eventId, organizerId },
    });

    if (!existingEvent) {
      throw new ApiError('Event not found or you do not have permission to update it', 404);
    }

    // Build update object
    const updateObj: any = {};
    if (updateData.title) updateObj.title = updateData.title;
    if (updateData.description) updateObj.description = updateData.description;
    if (updateData.location) {
      Object.assign(updateObj, flattenEventLocation(updateData.location));
    }
    if (updateData.startDate) updateObj.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateObj.endDate = new Date(updateData.endDate);
    if (updateData.isPublished !== undefined) updateObj.isPublished = updateData.isPublished;
    if (updateData.coverImage !== undefined) updateObj.coverImage = updateData.coverImage;
    if (updateData.category) updateObj.category = updateData.category;

    // Update the event
    const event = await prisma.event.update({
      where: { id: eventId },
      data: updateObj,
      include: {
        organizer: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    return transformEvent(event);
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
  organizerId: string,
  isAdmin = false
): Promise<{ message: string }> => {
  try {
    // Admins can delete any event; organizers are scoped to their own.
    const event = await prisma.event.findFirst({
      where: isAdmin ? { id: eventId } : { id: eventId, organizerId },
    });

    if (!event) {
      throw new ApiError('Event not found or you do not have permission to delete it', 404);
    }

    // Delete the event (cascade will delete related ticketTypes and tickets)
    await prisma.event.delete({
      where: { id: eventId },
    });

    return { message: 'Event deleted successfully' };
  } catch (error) {
    console.error('Error in deleteEvent service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to delete event', 500);
  }
};
