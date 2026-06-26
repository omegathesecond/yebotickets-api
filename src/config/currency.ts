/**
 * Single source of truth for the currency + default country YeboTickets
 * prices, charges, and reports in. The market is Eswatini, so everything is
 * SZL (Lilangeni, symbol "E") / country SZ. Import these instead of hardcoding
 * a currency string anywhere — drift here is how the dashboard once ended up
 * reporting revenue in "KES".
 */
export const TICKET_CURRENCY = 'SZL';
export const DEFAULT_COUNTRY = 'SZ';
