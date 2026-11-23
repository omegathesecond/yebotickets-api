/** Shared original ticket, holder and event fields for issuance and reviewed delivery. */
export const PURCHASE_INCLUDE = {
  event: {
    select: {
      isCancelled: true,
      id: true,
      title: true,
      startDate: true,
      endDate: true,
      locationAddress: true,
      locationCity: true,
      locationCountry: true,
    },
  },
  ticketType: {
    select: {
      id: true,
      name: true,
      type: true,
    },
  },
  user: {
    select: {
      id: true,
      name: true,
      phoneNumber: true,
      email: true,
    },
  },
} as const;
