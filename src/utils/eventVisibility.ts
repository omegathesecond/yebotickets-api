import { ApiError } from '../middleware/error.middleware';
import { UserRole } from '../interfaces/user.interface';

export type EventViewer = { id: string; role: string } | null;

/** Shared public/detail/inventory visibility; callers supply only verified identity. */
export const assertEventVisible = (
  event: { organizerId: string; isPublished: boolean; isCancelled: boolean } | null,
  viewer?: EventViewer
): boolean => {
  const privileged = !!event && (!!viewer && viewer.id === event.organizerId || viewer?.role === UserRole.ADMIN);
  if (!event || ((!event.isPublished || event.isCancelled) && !privileged)) {
    throw new ApiError('Event not found', 404);
  }
  return privileged;
};
