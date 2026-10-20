import { ApiError } from '../middleware/error.middleware';

/** Validate the complete interval, including dates retained by a partial update. */
export const assertDateInterval = (start: unknown, end: unknown, message: string): void => {
  const timestamp = (value: unknown): number =>
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  const startTime = timestamp(start);
  const endTime = timestamp(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    throw new ApiError(message, 400);
  }
};
