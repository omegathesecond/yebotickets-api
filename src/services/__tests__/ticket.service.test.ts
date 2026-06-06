import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// --- Mock the Prisma singleton ---------------------------------------------
// ticket.service imports `prisma` as the DEFAULT export of ../config/prisma.
// Replace that module with a deep jest mock so every prisma.<model>.<op>() is a
// typed jest.fn we can stub per-test — no database is touched.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// --- Mock the side-effecting collaborators ---------------------------------
// purchaseTicket generates a QR and delivers it over WhatsApp. We stub both so
// the unit under test stays focused on the sell/charge/check-in logic and never
// makes a network call or renders a real image.
jest.mock('../qr.service', () => ({
  buildTicketQrPayload: jest.fn((eventId: string, uniqueCode: string) => ({
    eventId,
    ticketId: uniqueCode,
  })),
  generateTicketQrDataUrl: jest.fn(async () => 'data:image/png;base64,FAKEQR'),
  generateTicketQrBuffer: jest.fn(async () => Buffer.from('fake-qr-png')),
}));

jest.mock('../whatsapp.service', () => ({
  sendImageMessage: jest.fn(async () => ({ ok: true })),
}));

// Mock the YeboPay client so the purchase flow never hits the gateway. The
// payment outcome (SUCCEEDED / FAILED / PENDING / throw) is driven per-test.
jest.mock('../yebopay.service', () => ({
  createCharge: jest.fn(),
  listPaymentOptions: jest.fn(),
  YeboPayHttpError: class YeboPayHttpError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
      public readonly path: string
    ) {
      super(`YeboPay ${path} failed: ${status}`);
      this.name = 'YeboPayHttpError';
    }
  },
}));

// Imports must come AFTER the jest.mock calls so the mocked modules are wired in.
import prisma from '../../config/prisma';
import { purchaseTicket, verifyTicket } from '../ticket.service';
import { sendImageMessage } from '../whatsapp.service';
import { createCharge } from '../yebopay.service';
import { TicketStatus } from '../../interfaces/ticket.interface';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const sendImageMessageMock = sendImageMessage as jest.MockedFunction<typeof sendImageMessage>;
const createChargeMock = createCharge as jest.MockedFunction<typeof createCharge>;

beforeEach(() => {
  // Reset return-value stubs between tests (clearMocks in jest.config only
  // clears call records, not the implementations jest-mock-extended installs).
  mockReset(prismaMock);
  sendImageMessageMock.mockResolvedValue({ ok: true } as any);
  createChargeMock.mockReset();
});

// --- Fixtures ---------------------------------------------------------------
const buildTicketType = (over: Partial<any> = {}) => ({
  id: 'tt-1',
  name: 'General Admission',
  description: null,
  price: 100,
  quantity: 50,
  eventId: 'event-1',
  type: 'standard',
  saleStartDate: new Date('2026-01-01T00:00:00Z'),
  saleEndDate: new Date('2026-12-31T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const buildAvailableTicket = (over: Partial<any> = {}) => ({
  id: 'ticket-1',
  ticketTypeId: 'tt-1',
  eventId: 'event-1',
  userId: null,
  status: 'available',
  purchaseDate: null,
  uniqueCode: 'ABC123',
  isCheckedIn: false,
  checkedInAt: null,
  paymentRef: null,
  paymentStatus: null,
  amountPaid: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

// A ticket as returned by prisma.ticket.findUnique with PURCHASE_INCLUDE
// relations (after a claim/reserve/finalize).
const buildTicketWithRelations = (over: Partial<any> = {}) => ({
  ...buildAvailableTicket({ userId: 'user-1', status: 'sold', purchaseDate: new Date() }),
  event: {
    id: 'event-1',
    title: 'Test Fest',
    startDate: new Date('2026-07-01T18:00:00Z'),
    endDate: new Date('2026-07-01T23:00:00Z'),
    locationAddress: '1 Main St',
    locationCity: 'Mbabane',
    locationCountry: 'Eswatini',
  },
  ticketType: { id: 'tt-1', name: 'General Admission', type: 'standard' },
  user: { id: 'user-1', name: 'Buyer', phoneNumber: '+26878000000' },
  ...over,
});

// A ticket as returned by findTicketForCheckIn with CHECK_IN_INCLUDE relations.
const buildCheckInTicket = (over: Partial<any> = {}) => ({
  id: 'ticket-1',
  uniqueCode: 'ABC123',
  ticketTypeId: 'tt-1',
  eventId: 'event-1',
  userId: 'user-1',
  status: 'sold',
  isCheckedIn: false,
  checkedInAt: null,
  purchaseDate: new Date('2026-06-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  event: { id: 'event-1', title: 'Test Fest', startDate: new Date(), endDate: new Date() },
  ticketType: { id: 'tt-1', name: 'General Admission', type: 'standard' },
  user: { id: 'user-1', name: 'Buyer', phoneNumber: '+26878000000' },
  ...over,
});

// A SUCCEEDED YeboPay charge result.
const buildCharge = (over: Partial<any> = {}) => ({
  id: 'chg_1',
  status: 'SUCCEEDED',
  amount: '100',
  currency: 'SZL',
  payment_instrument_id: null,
  provider_code: 'mtn-momo-sz',
  external_ref: 'ext-1',
  failure_reason: null,
  refunded_amount: '0',
  description: null,
  created_at: '2026-06-06T00:00:00Z',
  ...over,
});

// A valid one-off mobile-money payment input.
const PAYMENT = {
  providerCode: 'mtn-momo-sz',
  phone: '+26878000000',
  country: 'SZ',
  idempotencyKey: 'idem-1',
};

describe('purchaseTicket — payment + atomic claim', () => {
  it('reserves a ticket, charges via YeboPay, and finalizes to sold with the charge ref on SUCCEEDED', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    // Reserve candidate then both reserve + finalize claims win (count 1).
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce(buildTicketWithRelations({ status: 'reserved' }) as any) // reserve re-fetch
      .mockResolvedValueOnce(
        buildTicketWithRelations({
          status: 'sold',
          paymentRef: 'chg_1',
          paymentStatus: 'SUCCEEDED',
          amountPaid: 100,
        }) as any
      ); // finalize re-fetch
    createChargeMock.mockResolvedValue(buildCharge() as any);

    const result = await purchaseTicket('tt-1', 'user-1', PAYMENT);

    // Charged BEFORE issuing, for the ticket-type price, against the buyer.
    expect(createChargeMock).toHaveBeenCalledTimes(1);
    const chargeArg = createChargeMock.mock.calls[0][0];
    expect(chargeArg).toMatchObject({
      amount: 100,
      currency: 'SZL',
      yeboidSub: 'user-1',
      providerCode: 'mtn-momo-sz',
      phone: '+26878000000',
      country: 'SZ',
      idempotencyKey: 'idem-1',
    });

    // Two guarded writes: first reserves (available -> reserved), then finalizes
    // (reserved -> sold + payment ref). Both are conditional updateMany — a plain
    // update by id would reintroduce the oversell race.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
    const reserveArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(reserveArg.where).toEqual({ id: 'ticket-1', status: 'available', userId: null });
    expect(reserveArg.data).toMatchObject({ userId: 'user-1', status: 'reserved' });
    const finalizeArg = prismaMock.ticket.updateMany.mock.calls[1][0];
    expect(finalizeArg.where).toEqual({ id: 'ticket-1', status: 'reserved', userId: 'user-1' });
    expect(finalizeArg.data).toMatchObject({
      status: 'sold',
      purchaseDate: expect.any(Date),
      paymentRef: 'chg_1',
      paymentStatus: 'SUCCEEDED',
      amountPaid: 100,
    });

    // The returned ticket reflects the paid sale and carries a QR for the buyer.
    expect(result.status).toBe(TicketStatus.SOLD);
    expect(result.paymentRef).toBe('chg_1');
    expect(result.amountPaid).toBe(100);
    expect(result.qrCode).toBe('data:image/png;base64,FAKEQR');
    expect(result.delivery).toEqual({ channel: 'whatsapp', status: 'sent' });
  });

  it('rejects a priced purchase with no payment details (400) and never reserves or charges', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);

    await expect(purchaseTicket('tt-1', 'user-1')).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(createChargeMock).not.toHaveBeenCalled();
  });

  it('a FAILED charge issues NO ticket, releases the reservation, and throws (402)', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any); // reserve + release
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildTicketWithRelations({ status: 'reserved' }) as any
    );
    createChargeMock.mockResolvedValue(
      buildCharge({ status: 'FAILED', failure_reason: 'insufficient funds' }) as any
    );

    await expect(purchaseTicket('tt-1', 'user-1', PAYMENT)).rejects.toMatchObject({
      statusCode: 402,
    });

    // It reserved (updateMany #1) then RELEASED the hold (updateMany #2 back to
    // available) — it never finalized a sale and never delivered a ticket.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(2);
    const reserveArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(reserveArg.data).toMatchObject({ status: 'reserved' });
    const releaseArg = prismaMock.ticket.updateMany.mock.calls[1][0];
    expect(releaseArg.where).toEqual({ id: 'ticket-1', status: 'reserved', userId: 'user-1' });
    expect(releaseArg.data).toEqual({ status: 'available', userId: null });
    // Crucially: no write ever flips the row to 'sold' on a failed charge.
    const soldWrites = prismaMock.ticket.updateMany.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'sold'
    );
    expect(soldWrites).toHaveLength(0);
    expect(sendImageMessageMock).not.toHaveBeenCalled();
  });

  it('a PENDING charge also issues NO ticket and releases the reservation (402)', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildTicketWithRelations({ status: 'reserved' }) as any
    );
    createChargeMock.mockResolvedValue(buildCharge({ status: 'PENDING' }) as any);

    await expect(purchaseTicket('tt-1', 'user-1', PAYMENT)).rejects.toMatchObject({
      statusCode: 402,
    });
    const soldWrites = prismaMock.ticket.updateMany.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'sold'
    );
    expect(soldWrites).toHaveLength(0);
    expect(sendImageMessageMock).not.toHaveBeenCalled();
  });

  it('a free (price 0) ticket skips the charge and is issued straight to sold', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType({ price: 0 }) as any);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildTicketWithRelations({ status: 'sold', paymentStatus: 'FREE', amountPaid: 0 }) as any
    );

    const result = await purchaseTicket('tt-1', 'user-1');

    // No money is moved for a free ticket.
    expect(createChargeMock).not.toHaveBeenCalled();
    // One guarded claim straight to sold, tagged FREE.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(claimArg.data).toMatchObject({
      userId: 'user-1',
      status: 'sold',
      purchaseDate: expect.any(Date),
      paymentStatus: 'FREE',
      amountPaid: 0,
    });
    expect(result.status).toBe(TicketStatus.SOLD);
    expect(result.paymentStatus).toBe('FREE');
  });

  it('throws when no available ticket exists for the ticket type (no charge)', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue(null);

    await expect(purchaseTicket('tt-1', 'user-1', PAYMENT)).rejects.toMatchObject({
      message: 'No tickets available for this ticket type',
      statusCode: 400,
    });

    // No reservation, and crucially no charge, when nothing is available.
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(createChargeMock).not.toHaveBeenCalled();
  });

  it('fails the loser of a concurrent race: a guarded reserve on an already-taken row matches no rows', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    // Buyer reads ticket-1 as available, but by the time the guarded reserve runs
    // another buyer has already taken it, so updateMany matches 0 rows. With no
    // other ticket free, the retry finds nothing and the buyer is refused.
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ id: 'ticket-1' } as any) // looked available...
      .mockResolvedValueOnce(null); // ...but the pool is now exhausted on retry
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 } as any);

    await expect(purchaseTicket('tt-1', 'user-2', PAYMENT)).rejects.toMatchObject({
      message: 'No tickets available for this ticket type',
      statusCode: 400,
    });

    // It attempted the guarded reserve and lost (count 0), then never charged and
    // never fabricated a sale — findUnique (the post-win re-fetch) must not run.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const reserveArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(reserveArg.where).toEqual({ id: 'ticket-1', status: 'available', userId: null });
    expect(prismaMock.ticket.findUnique).not.toHaveBeenCalled();
    expect(createChargeMock).not.toHaveBeenCalled();
  });

  it('never allocates one ticket row to two concurrent buyers (single-row pool)', async () => {
    // A real-DB stand-in: an in-memory pool of ONE available row whose
    // updateMany applies the SAME guard the service relies on. This models the
    // atomic conditional write — the first matching claim flips the row and
    // every later guarded claim misses — so two buyers truly contend for it.
    const rows: any[] = [buildAvailableTicket({ id: 'ticket-1' })];

    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockImplementation(async (args: any) => {
      const w = args.where;
      const hit = rows.find(
        r =>
          r.ticketTypeId === w.ticketTypeId &&
          r.status === w.status &&
          r.userId === w.userId
      );
      return hit ? ({ id: hit.id } as any) : null;
    });
    prismaMock.ticket.updateMany.mockImplementation(async (args: any) => {
      const w = args.where;
      const row = rows.find(
        r => r.id === w.id && r.status === w.status && r.userId === w.userId
      );
      if (!row) return { count: 0 } as any;
      Object.assign(row, args.data); // atomic flip (available->reserved->sold)
      return { count: 1 } as any;
    });
    prismaMock.ticket.findUnique.mockImplementation(async (args: any) => {
      const row = rows.find(r => r.id === args.where.id);
      return row ? (buildTicketWithRelations({ ...row }) as any) : null;
    });
    createChargeMock.mockResolvedValue(buildCharge() as any);

    const outcomes = await Promise.allSettled([
      purchaseTicket('tt-1', 'user-1', { ...PAYMENT, idempotencyKey: 'k1' }),
      purchaseTicket('tt-1', 'user-2', { ...PAYMENT, idempotencyKey: 'k2' }),
    ]);

    const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
    const rejected = outcomes.filter(o => o.status === 'rejected');

    // Exactly one buyer wins the single row; the other is cleanly refused —
    // never two winners, never an oversell.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: 'No tickets available for this ticket type',
      statusCode: 400,
    });

    // The single row ended up sold to exactly one user, never double-allocated,
    // and only that one winner was charged.
    expect(rows[0].status).toBe('sold');
    expect(['user-1', 'user-2']).toContain(rows[0].userId);
    expect(createChargeMock).toHaveBeenCalledTimes(1);
  });

  it('throws on an unknown ticketTypeId', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(null);

    await expect(purchaseTicket('does-not-exist', 'user-1', PAYMENT)).rejects.toMatchObject({
      message: 'Ticket type not found',
      statusCode: 404,
    });

    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(createChargeMock).not.toHaveBeenCalled();
  });
});

describe('verifyTicket (gate check-in guard)', () => {
  const requester = { id: 'admin-1', role: 'admin' };

  const grantEventAccess = () =>
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);

  it('checks in a sold, un-checked ticket and sets isCheckedIn/checkedInAt', async () => {
    grantEventAccess();
    prismaMock.ticket.findFirst.mockResolvedValue(buildCheckInTicket() as any);
    prismaMock.ticket.update.mockResolvedValue(
      buildCheckInTicket({ isCheckedIn: true, checkedInAt: new Date() }) as any
    );

    const result = await verifyTicket('ABC123', 'event-1', requester);

    expect(result.valid).toBe(true);
    expect(result.message).toBe('Check-in successful');
    expect(prismaMock.ticket.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.ticket.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'ticket-1' });
    expect(updateArg.data).toMatchObject({
      isCheckedIn: true,
      checkedInAt: expect.any(Date),
    });
  });

  it('REJECTS an already-checked-in ticket without mutating it', async () => {
    grantEventAccess();
    prismaMock.ticket.findFirst.mockResolvedValue(buildCheckInTicket({ isCheckedIn: true }) as any);

    const result = await verifyTicket('ABC123', 'event-1', requester);

    expect(result.valid).toBe(false);
    expect(result.message).toBe('Ticket has already been used for check-in');
    // The double-entry guard must never re-stamp an already-used ticket.
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it("REJECTS a ticket whose status is not 'sold'", async () => {
    grantEventAccess();
    prismaMock.ticket.findFirst.mockResolvedValue(buildCheckInTicket({ status: 'available' }) as any);

    const result = await verifyTicket('ABC123', 'event-1', requester);

    expect(result.valid).toBe(false);
    expect(result.message).toBe('Ticket is not valid for check-in');
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it('REJECTS an unknown ticket code', async () => {
    grantEventAccess();
    prismaMock.ticket.findFirst.mockResolvedValue(null);

    const result = await verifyTicket('NOPE', 'event-1', requester);

    expect(result.valid).toBe(false);
    expect(result.message).toBe('Invalid ticket code');
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it('scopes the ticket lookup by eventId (no cross-event check-in)', async () => {
    grantEventAccess();
    prismaMock.ticket.findFirst.mockResolvedValue(buildCheckInTicket() as any);
    prismaMock.ticket.update.mockResolvedValue(
      buildCheckInTicket({ isCheckedIn: true, checkedInAt: new Date() }) as any
    );

    await verifyTicket('ABC123', 'event-99', requester);

    expect(prismaMock.ticket.findFirst).toHaveBeenCalledTimes(1);
    const findArg = prismaMock.ticket.findFirst.mock.calls[0][0];
    expect(findArg.where.eventId).toBe('event-99');
    // The code may be matched as either the db id or the uniqueCode.
    expect(findArg.where.OR).toEqual([{ id: 'ABC123' }, { uniqueCode: 'ABC123' }]);
  });
});
