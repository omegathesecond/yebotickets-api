import { ApiError } from '../middleware/error.middleware';
import { UserRole } from '../interfaces/user.interface';
import { staffAdminScope } from '../config/prisma';

export type EventViewer = { id: string; role: string } | null;

/** An omitted owner is allowed only inside a verified corporate request. */
export const eventOwnershipFilter = (
  organizerId: string | undefined
): { organizerId?: string } => {
  if (typeof organizerId === 'string' && organizerId.length > 0)
    return { organizerId };
  if (organizerId === undefined && staffAdminScope.actor()) return {};
  throw new ApiError(
    'An authenticated event owner or corporate actor is required',
    401
  );
};

/** Shared public/detail/inventory visibility; callers supply only verified identity. */
export const assertEventVisible = (
  event: {
    organizerId: string;
    isPublished: boolean;
    isCancelled: boolean;
  } | null,
  viewer?: EventViewer
): boolean => {
  const privileged =
    !!event &&
    (!!staffAdminScope.actor() ||
      (!!viewer && viewer.id === event.organizerId) ||
      viewer?.role === UserRole.ADMIN);
  if (!event || ((!event.isPublished || event.isCancelled) && !privileged)) {
    throw new ApiError('Event not found', 404);
  }
  return privileged;
};
