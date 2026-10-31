import { ApiError } from '../middleware/error.middleware';

export const PRICE_ERROR = 'Price must be a finite, non-negative number in SZL with at most 2 decimal places';

/** Exact cent round-trip accepts decimal prices despite binary multiplication noise. */
export const isCentAmount = (amount: unknown): amount is number => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return false;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents / 100 === amount;
};

export const amountToCents = (amount: unknown): number => {
  if (!isCentAmount(amount)) throw new ApiError(PRICE_ERROR, 400);
  return Math.round(amount * 100);
};

export const orderAmount = (unitPrice: unknown, quantity: number): number => {
  const total = amountToCents(unitPrice) * quantity;
  if (!Number.isSafeInteger(total)) throw new ApiError('Order amount exceeds safe SZL cent precision', 400);
  const amount = total / 100;
  if (amountToCents(amount) !== total) throw new ApiError('Order amount exceeds safe SZL cent precision', 400);
  return amount;
};
