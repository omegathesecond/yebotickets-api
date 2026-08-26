/**
 * Platform-level money settings.
 *
 * Kept in one module so the currency label and the commission rate have exactly
 * one definition each — the settlement calculation, the payout records and the
 * organizer-dashboard read models all read them from here.
 */

/** Currency every ticket is priced and charged in (Eswatini lilangeni). */
export const CURRENCY = 'SZL';

/**
 * The platform's commission on ticket sales, as a percentage of gross.
 *
 * Sourced from PLATFORM_FEE_PERCENT. UNSET means 0 — the business has not set a
 * rate yet, so organizers are owed 100% of gross and behaviour is unchanged.
 *
 * An unset value is a deliberate default; a SET-BUT-INVALID value is a
 * misconfiguration and throws rather than silently falling back to 0 — quietly
 * treating `PLATFORM_FEE_PERCENT=ten` as "no commission" would hand away the
 * platform's revenue without anyone noticing.
 */
export const getPlatformFeePercent = (): number => {
  const raw = process.env.PLATFORM_FEE_PERCENT;
  if (raw === undefined || raw === null || raw.trim() === '') return 0;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= 100) {
    throw new Error(
      `PLATFORM_FEE_PERCENT must be a number >= 0 and < 100, got "${raw}"`
    );
  }
  return value;
};

/** Round a money figure to 2dp, killing float drift (0.1 + 0.2 === 0.30000000000000004). */
export const roundMoney = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
