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
  // Surface cancellation so a client landing on a cancelled event (e.g. via a
  // stale link) can show it's off-sale rather than silently offer to buy.
  isCancelled: event.isCancelled ?? false,
  cancelledAt: event.cancelledAt ?? null,
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

// Default page size when the caller sends no `limit` (matches the previous
// hardcoded cap so existing callers see no size change). `MAX_LIMIT` bounds
// any explicitly-requested limit so a client can't force an unbounded scan.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const toPositiveInt = (value: any, fallback: number): number => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Get all events with optional filtering and pagination
 * @param query Query parameters for filtering
 * @returns `{ data, total, page, limit, hasMore }` — `data` is the page of
 *   events, `total` the full match count across all pages.
 */
export const getEvents = async (query: Record<string, any> = {}) => {
  try {
    const where: any = {};

    // Build filter based on query parameters. City/country use case-insensitive
    // contains so the buyer app's city pills ("Mbabane") and country dropdown
    // ("Eswatini") match regardless of how the value was stored/cased.
    if (query.category) where.category = query.category;
    if (query.city) where.locationCity = { contains: query.city, mode: 'insensitive' };
    if (query.country) where.locationCountry = { contains: query.country, mode: 'insensitive' };

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

    // Default the listing to upcoming events only: exclude anything whose
    // endDate has already passed (endDate, not startDate, so a multi-day
    // event still shows on its final day). Without this, ordering ascending
    // by startDate surfaces the OLDEST dead events first and they consume the
    // page budget, pushing genuinely upcoming events off the end of the list.
    // Organizer/admin surfaces that legitimately need history (e.g. their own
    // past events) opt out with includePast=true.
    if (query.includePast !== 'true') {
      where.endDate = { gte: new Date() };
    }

    // By default, only return published events unless specified
    if (query.showUnpublished !== 'true') {
      where.isPublished = true;
    }

    // Exclude cancelled events from listings by default. cancelEvent flags
    // isCancelled; without this filter a cancelled event keeps appearing in the
    // public buyer listing and selling tickets. An organizer dashboard can opt
    // in to see its own cancelled events via showCancelled=true.
    if (query.showCancelled !== 'true') {
      where.isCancelled = false;
    }

    // Organizer filter
    if (query.organizer) {
      where.organizerId = query.organizer;
    }

    // Free-text search across title, description, category and city so the
    // home-page search bar (which only sends a single term) matches by
    // title/category/city as the buyer expects, not just the title.
    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
        { locationCity: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const page = toPositiveInt(query.page, 1);
    const limit = Math.min(toPositiveInt(query.limit, DEFAULT_LIMIT), MAX_LIMIT);
    const skip = (page - 1) * limit;

    const [events, total] = await prisma.$transaction([
      prisma.event.findMany({
        where,
        include: {
          organizer: {
            select: { id: true, name: true, email: true },
          },
        },
        orderBy: { startDate: 'asc' },
        skip,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    return {
      data: events.map(transformEvent),
      total,
      page,
      limit,
      hasMore: skip + events.length < total,
    };
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
  organizerId: string
) => {
  try {
    // First check if the event exists and belongs to this organizer
    const existingEvent = await prisma.event.findFirst({
      where: {
        id: eventId,
        organizerId,
      },
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
 * Admin-only unpublish/takedown. Unlike updateEvent, this is NOT scoped to the
 * calling organizer — a platform admin needs to be able to pull a
 * fraudulent/abusive listing off sale on ANY event regardless of who owns it.
 * Route-level authorize(ADMIN) is what gates access; this function does not
 * re-check role itself.
 * @param eventId Event ID
 * @returns Updated event
 */
export const adminUnpublishEvent = async (eventId: string) => {
  try {
    const existingEvent = await prisma.event.findUnique({ where: { id: eventId } });

    if (!existingEvent) {
      throw new ApiError('Event not found', 404);
    }

    const event = await prisma.event.update({
      where: { id: eventId },
      data: { isPublished: false },
      include: {
        organizer: { select: { id: true, name: true, email: true } },
      },
    });

    return transformEvent(event);
  } catch (error) {
    console.error('Error in adminUnpublishEvent service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to unpublish event', 500);
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
    const event = await prisma.event.findFirst({
      where: {
        id: eventId,
        organizerId,
      },
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
