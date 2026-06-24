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
// purchaseTicket generates a QR and delivers the ticket over YeboLink (WhatsApp,
// with email as a fallback channel). We stub the QR + comms collaborators so the
// unit under test stays focused on the sell/charge/check-in logic and never
// makes a network call or renders a real image.
jest.mock('../qr.service', () => ({
  buildTicketQrPayload: jest.fn((eventId: string, uniqueCode: string) => ({
    eventId,
    ticketId: uniqueCode,
  })),
  generateTicketQrDataUrl: jest.fn(async () => 'data:image/png;base64,FAKEQR'),
  generateTicketQrBuffer: jest.fn(async () => Buffer.from('fake-qr-png')),
}));

jest.mock('../comms.service', () => ({
  sendTextMessage: jest.fn(async () => ({ ok: true })),
  sendEmailMessage: jest.fn(async () => ({ ok: true })),
}));

// Mock the YeboPay client so the purchase flow never hits the gateway. The
// payment outcome (SUCCEEDED / FAILED / PENDING / throw) is driven per-test.
jest.mock('../yebopay.service', () => ({
  createCharge: jest.fn(),
  getCharge: jest.fn(),
  listPaymentOptions: jest.fn(),
  refundCharge: jest.fn(),
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
import {
  purchaseTicket,
  verifyTicket,
  refundTicket,
  cancelEvent,
  settleSucceededCharge,
  settleFailedCharge,
  handleChargeWebhookEvent,
  reclaimExpiredReservations,
  getEventTicketsForCheckIn,
} from '../ticket.service';
import { sendTextMessage, sendEmailMessage } from '../comms.service';
import { createCharge, getCharge, refundCharge, YeboPayHttpError } from '../yebopay.service';
import { TicketStatus } from '../../interfaces/ticket.interface';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const sendTextMessageMock = sendTextMessage as jest.MockedFunction<typeof sendTextMessage>;
const sendEmailMessageMock = sendEmailMessage as jest.MockedFunction<typeof sendEmailMessage>;
const createChargeMock = createCharge as jest.MockedFunction<typeof createCharge>;
const getChargeMock = getCharge as jest.MockedFunction<typeof getCharge>;
const refundChargeMock = refundCharge as jest.MockedFunction<typeof refundCharge>;

beforeEach(() => {
  // Reset return-value stubs between tests (clearMocks in jest.config only
  // clears call records, not the implementations jest-mock-extended installs).
  mockReset(prismaMock);
  // Default: no stale reservations to reclaim. purchaseTicket's paid path runs a
  // reclaim sweep up front (prisma.ticket.findMany); without this the call would
  // see `undefined` and throw. Tests that exercise reclaim override it.
  prismaMock.ticket.findMany.mockResolvedValue([] as any);
  sendTextMessageMock.mockReset();
  sendTextMessageMock.mockResolvedValue({ ok: true } as any);
  sendEmailMessageMock.mockReset();
  sendEmailMessageMock.mockResolvedValue({ ok: true } as any);
  createChargeMock.mockReset();
  getChargeMock.mockReset();
  refundChargeMock.mockReset();
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
  // Relation loaded by purchaseTicket's `include` to gate sales on a cancelled
  // event. Default: event is live. Override `event` to simulate a cancellation.
  event: { isCancelled: false },
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
    // Release returns the row to the pool AND clears the (failed) payment trail
    // so the freed seat is pristine for the next buyer.
    expect(releaseArg.data).toEqual({
      status: 'available',
      userId: null,
      reservedAt: null,
      paymentRef: null,
      paymentStatus: null,
      amountPaid: null,
    });
    // Crucially: no write ever flips the row to 'sold' on a failed charge.
    const soldWrites = prismaMock.ticket.updateMany.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'sold'
    );
    expect(soldWrites).toHaveLength(0);
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('a PENDING (async mobile-money) charge HOLDS the reservation, persists the charge ref, and returns a pending result — no ticket issued, no release', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.ticket.findUnique
      .mockResolvedValueOnce(buildTicketWithRelations({ status: 'reserved' }) as any) // reserve re-fetch
      .mockResolvedValueOnce(
        buildTicketWithRelations({ status: 'reserved', paymentStatus: 'PENDING', amountPaid: 100 }) as any
      ); // mark-pending re-fetch
    createChargeMock.mockResolvedValue(buildCharge({ status: 'PENDING' }) as any);

    const result: any = await purchaseTicket('tt-1', 'user-1', PAYMENT);

    // Buyer is told it's pending — NOT a hard failure, NO QR yet.
    expect(result.pending).toBe(true);
    expect(result.paymentStatus).toBe('PENDING');
    expect(result.paymentRef).toBe('chg_1');
    expect(result.qrCode).toBeUndefined();
    expect(sendTextMessageMock).not.toHaveBeenCalled();

    // Two guarded writes: reserve (available->reserved) then mark-pending — but
    // NEVER a release (the seat stays held) and NEVER a flip to 'sold'.
    const reserveArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(reserveArg.data).toMatchObject({ status: 'reserved' });
    const pendingArg = prismaMock.ticket.updateMany.mock.calls[1][0];
    expect(pendingArg.where).toEqual({ id: 'ticket-1', status: 'reserved', userId: 'user-1' });
    expect(pendingArg.data).toMatchObject({ paymentRef: 'chg_1', paymentStatus: 'PENDING', amountPaid: 100 });
    // The mark-pending write must NOT flip status (no `status` key) — the seat
    // stays reserved.
    expect(pendingArg.data).not.toHaveProperty('status');

    const releaseWrites = prismaMock.ticket.updateMany.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'available'
    );
    expect(releaseWrites).toHaveLength(0);
    const soldWrites = prismaMock.ticket.updateMany.mock.calls.filter(
      (c: any) => c[0]?.data?.status === 'sold'
    );
    expect(soldWrites).toHaveLength(0);
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

  it('rejects a purchase for a CANCELLED event before reserving or charging', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(
      buildTicketType({ event: { isCancelled: true } }) as any
    );

    await expect(purchaseTicket('tt-1', 'user-1', PAYMENT)).rejects.toMatchObject({
      message: 'This event has been cancelled — tickets are no longer on sale.',
      statusCode: 400,
    });

    // No ticket is reserved and — critically — no money is taken: the guard
    // runs before any claim or YeboPay charge (no silent pay-for-dead-event).
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

// ---------------------------------------------------------------------------
// Refunds & event cancellation
// ---------------------------------------------------------------------------

// The owning organizer and an admin for the fixtures below.
const ORGANIZER = { id: 'org-1', role: 'organizer' };
const ADMIN = { id: 'admin-9', role: 'admin' };

// A sold, PAID ticket with the relations refundTicket/cancelEvent load
// (REFUND_INCLUDE: event, ticketType, user).
const buildSoldPaidTicket = (over: Partial<any> = {}) => ({
  id: 'ticket-1',
  uniqueCode: 'ABC123',
  ticketTypeId: 'tt-1',
  eventId: 'event-1',
  userId: 'user-1',
  status: 'sold',
  isCheckedIn: false,
  checkedInAt: null,
  purchaseDate: new Date('2026-06-01T00:00:00Z'),
  paymentRef: 'chg_1',
  paymentStatus: 'SUCCEEDED',
  amountPaid: 100,
  refundRef: null,
  refundedAt: null,
  cancelledAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  event: { id: 'event-1', title: 'Test Fest', startDate: new Date('2026-07-01T18:00:00Z') },
  ticketType: { id: 'tt-1', name: 'General Admission' },
  user: { id: 'user-1', name: 'Buyer', phoneNumber: '+26878000000' },
  ...over,
});

// A YeboPay refund result (full refund).
const buildRefundResult = (over: Partial<any> = {}) => ({
  charge_id: 'chg_1',
  refunded_amount: '100',
  status: 'REFUNDED' as const,
  processor_ref: 'rfnd_1',
  processor_status: 'reversed',
  ...over,
});

describe('refundTicket (single-ticket refund + cancel)', () => {
  it('refunds a paid sold ticket via YeboPay, marks it CANCELLED+REFUNDED, and notifies the holder', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldPaidTicket() as any);
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    refundChargeMock.mockResolvedValue(buildRefundResult() as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await refundTicket('ticket-1', ORGANIZER, 'changed my mind');

    // Refunded against the STORED charge ref, not re-derived.
    expect(refundChargeMock).toHaveBeenCalledTimes(1);
    expect(refundChargeMock.mock.calls[0][0]).toMatchObject({ chargeId: 'chg_1' });

    // The write flips status->cancelled and records the refund outcome.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const writeArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(writeArg.where).toMatchObject({ id: 'ticket-1', status: { not: 'cancelled' } });
    expect(writeArg.data).toMatchObject({
      status: 'cancelled',
      paymentStatus: 'REFUNDED',
      refundRef: 'rfnd_1',
    });

    expect(result).toMatchObject({
      result: 'refunded',
      amountRefunded: 100,
      refundRef: 'rfnd_1',
      notified: true,
    });
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: an already-cancelled ticket is a no-op (no YeboPay refund, no write)', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildSoldPaidTicket({ status: 'cancelled', paymentStatus: 'REFUNDED', refundRef: 'rfnd_1' }) as any
    );
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);

    const result = await refundTicket('ticket-1', ORGANIZER);

    expect(result.result).toBe('already_handled');
    expect(refundChargeMock).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT mark the ticket refunded when the YeboPay refund fails — throws 502, no write', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldPaidTicket() as any);
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    refundChargeMock.mockRejectedValue(new YeboPayHttpError(502, { error: 'Refund failed' }, '/v1/refunds'));

    await expect(refundTicket('ticket-1', ORGANIZER)).rejects.toMatchObject({ statusCode: 502 });

    // Crucially: no write ever flips the ticket to cancelled/refunded.
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('treats a YeboPay 409 (already refunded at the gateway) as an idempotent success', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldPaidTicket() as any);
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    refundChargeMock.mockRejectedValue(
      new YeboPayHttpError(409, { error: 'Cannot refund a charge in status REFUNDED' }, '/v1/refunds')
    );
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await refundTicket('ticket-1', ORGANIZER);

    expect(result.result).toBe('refunded');
    expect(result.refundRef).toBe('chg_1'); // falls back to the charge ref
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
  });

  it('cancels a FREE ticket without any YeboPay refund', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildSoldPaidTicket({ paymentRef: null, paymentStatus: 'FREE', amountPaid: 0 }) as any
    );
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await refundTicket('ticket-1', ORGANIZER);

    expect(result.result).toBe('cancelled_free');
    expect(refundChargeMock).not.toHaveBeenCalled();
    const writeArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(writeArg.data).toMatchObject({ status: 'cancelled' });
    expect(writeArg.data.paymentStatus).toBeUndefined(); // free: no REFUNDED marker
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a refund for an event the organizer does not own (403) — no refund, no write', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldPaidTicket() as any);
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'someone-else' } as any);

    await expect(refundTicket('ticket-1', ORGANIZER)).rejects.toMatchObject({ statusCode: 403 });

    expect(refundChargeMock).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 when the ticket does not exist', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(null);

    await expect(refundTicket('ticket-x', ORGANIZER)).rejects.toMatchObject({ statusCode: 404 });
    expect(refundChargeMock).not.toHaveBeenCalled();
  });

  it('lets an ADMIN refund a ticket for an event they do not own', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldPaidTicket() as any);
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    refundChargeMock.mockResolvedValue(buildRefundResult() as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);

    const result = await refundTicket('ticket-1', ADMIN);

    expect(result.result).toBe('refunded');
    expect(refundChargeMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancelEvent (refund all sold tickets + cancel)', () => {
  it('flags the event cancelled and refunds every sold ticket (free tickets just void)', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    prismaMock.event.update.mockResolvedValue({ id: 'event-1', title: 'Test Fest', isCancelled: true } as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      buildSoldPaidTicket({ id: 'paid-1', uniqueCode: 'PAID1' }),
      buildSoldPaidTicket({ id: 'free-1', uniqueCode: 'FREE1', paymentRef: null, paymentStatus: 'FREE', amountPaid: 0 }),
    ] as any);
    refundChargeMock.mockResolvedValue(buildRefundResult() as any);
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);

    const summary = await cancelEvent('event-1', ORGANIZER);

    // Event flagged cancelled exactly once.
    expect(prismaMock.event.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.event.update.mock.calls[0][0].data).toMatchObject({ isCancelled: true });

    // Only the PAID ticket is refunded; the free one is voided without a charge.
    expect(refundChargeMock).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      eventId: 'event-1',
      cancelled: true,
      totalProcessed: 2,
      refunded: 1,
      cancelledFree: 1,
      failed: 0,
    });
    // Both holders notified.
    expect(sendTextMessageMock).toHaveBeenCalledTimes(2);
  });

  it('enforces ownership: a non-owner organizer cannot cancel (403) and the event is NOT flagged', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'someone-else' } as any);

    await expect(cancelEvent('event-1', ORGANIZER)).rejects.toMatchObject({ statusCode: 403 });

    expect(prismaMock.event.update).not.toHaveBeenCalled();
    expect(refundChargeMock).not.toHaveBeenCalled();
  });

  it('reports a failed refund without marking that ticket refunded (event still cancelled)', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    prismaMock.event.update.mockResolvedValue({ id: 'event-1', title: 'Test Fest', isCancelled: true } as any);
    prismaMock.ticket.findMany.mockResolvedValue([
      buildSoldPaidTicket({ id: 'paid-1', uniqueCode: 'PAID1' }),
    ] as any);
    refundChargeMock.mockRejectedValue(new YeboPayHttpError(502, { error: 'down' }, '/v1/refunds'));

    const summary = await cancelEvent('event-1', ORGANIZER);

    expect(summary).toMatchObject({ cancelled: true, totalProcessed: 1, refunded: 0, failed: 1 });
    expect(summary.outcomes[0].result).toBe('refund_failed');
    // The event is flagged, but the failed ticket was never marked cancelled.
    expect(prismaMock.event.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('lets an ADMIN cancel any event', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId: 'org-1' } as any);
    prismaMock.event.update.mockResolvedValue({ id: 'event-1', title: 'Test Fest', isCancelled: true } as any);
    prismaMock.ticket.findMany.mockResolvedValue([] as any);

    const summary = await cancelEvent('event-1', ADMIN);

    expect(summary).toMatchObject({ cancelled: true, totalProcessed: 0, refunded: 0, failed: 0 });
    expect(prismaMock.event.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Asynchronous settlement: YeboPay charge webhooks
// ---------------------------------------------------------------------------
describe('charge webhook settlement (async mobile-money)', () => {
  const buildReserved = (over: Partial<any> = {}) =>
    buildTicketWithRelations({
      status: 'reserved',
      userId: 'user-1',
      paymentRef: 'chg_1',
      paymentStatus: 'PENDING',
      amountPaid: 100,
      ...over,
    });

  it('charge.succeeded finalizes the reserved ticket to SOLD and delivers the QR (exactly once)', async () => {
    // First delivery: reserved -> sold + deliver.
    prismaMock.ticket.findFirst.mockResolvedValueOnce(buildReserved() as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValueOnce(
      buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED', amountPaid: 100 }) as any
    );

    const outcome = await handleChargeWebhookEvent('charge.succeeded', { id: 'chg_1' });

    expect(outcome).toMatchObject({ result: 'issued', ticketId: 'ticket-1' });
    // The flip is a GUARDED updateMany requiring status 'reserved' (idempotency).
    const flip = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(flip.where).toMatchObject({ paymentRef: 'chg_1', status: 'reserved' });
    expect(flip.data).toMatchObject({ status: 'sold', paymentStatus: 'SUCCEEDED' });
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
  });

  it('a redelivered charge.succeeded is an idempotent no-op (already sold; no second flip, no second QR)', async () => {
    // The ticket is already sold by the time the duplicate arrives.
    prismaMock.ticket.findFirst.mockResolvedValueOnce(
      buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED' }) as any
    );

    const outcome = await settleSucceededCharge('chg_1');

    expect(outcome).toMatchObject({ result: 'already_final', status: 'sold' });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('a concurrent finalize (guarded write matches 0 rows) issues no duplicate and does not deliver again', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(buildReserved() as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 0 } as any); // lost the race

    const outcome = await settleSucceededCharge('chg_1');

    expect(outcome).toMatchObject({ result: 'already_final', status: 'sold' });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('charge.failed releases the reservation back to the pool', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(buildReserved() as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any); // release

    const outcome = await handleChargeWebhookEvent('charge.failed', { id: 'chg_1' });

    expect(outcome).toMatchObject({ result: 'released', ticketId: 'ticket-1' });
    const release = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(release.where).toMatchObject({ id: 'ticket-1', status: 'reserved' });
    expect(release.data).toMatchObject({ status: 'available', userId: null, paymentRef: null });
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('charge.failed for an already-SOLD ticket does NOT unwind it (conflict — left sold)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(
      buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED' }) as any
    );

    const outcome = await settleFailedCharge('chg_1');

    expect(outcome).toMatchObject({ result: 'already_final', status: 'sold' });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('a charge.succeeded matching no ticket is reported unmatched (no write) — surfaced for reconciliation', async () => {
    prismaMock.ticket.findFirst.mockResolvedValueOnce(null as any);

    const outcome = await settleSucceededCharge('chg_unknown');

    expect(outcome).toEqual({ result: 'unmatched' });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
    expect(sendTextMessageMock).not.toHaveBeenCalled();
  });

  it('an unhandled event type (e.g. checkout.completed) is ignored without touching tickets', async () => {
    const outcome = await handleChargeWebhookEvent('checkout.completed', { id: 'co_1' });
    expect(outcome).toEqual({ result: 'ignored' });
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('PENDING-then-SUCCEEDED issues EXACTLY ONE ticket across a webhook + its redelivery', async () => {
    // 1st webhook: reserved -> sold + deliver. 2nd (duplicate): already sold.
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce(buildReserved() as any)
      .mockResolvedValueOnce(
        buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED' }) as any
      );
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValueOnce(
      buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED' }) as any
    );

    const first = await settleSucceededCharge('chg_1');
    const second = await settleSucceededCharge('chg_1');

    expect(first).toMatchObject({ result: 'issued' });
    expect(second).toMatchObject({ result: 'already_final', status: 'sold' });
    // Exactly one flip-to-sold and one QR delivery, never two.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Reservation reclaim sweep (TTL + authoritative YeboPay poll)
// ---------------------------------------------------------------------------
describe('reclaimExpiredReservations', () => {
  const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

  const staleReserved = (over: Partial<any> = {}) =>
    buildTicketWithRelations({
      status: 'reserved',
      userId: 'user-1',
      paymentRef: 'chg_1',
      paymentStatus: 'PENDING',
      amountPaid: 100,
      reservedAt: minsAgo(20), // older than the 15-min TTL
      ...over,
    });

  it('finalizes a hold whose charge YeboPay now reports SUCCEEDED (reconciles a missed webhook)', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([staleReserved()] as any);
    getChargeMock.mockResolvedValueOnce(buildCharge({ status: 'SUCCEEDED' }) as any);
    // settleSucceededCharge re-looks-up by paymentRef, flips, delivers.
    prismaMock.ticket.findFirst.mockResolvedValueOnce(staleReserved() as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValueOnce(
      buildTicketWithRelations({ status: 'sold', paymentRef: 'chg_1', paymentStatus: 'SUCCEEDED' }) as any
    );

    const summary = await reclaimExpiredReservations();

    expect(summary).toMatchObject({ scanned: 1, finalized: 1, released: 0 });
    expect(getChargeMock).toHaveBeenCalledWith('chg_1');
    expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
  });

  it('releases a hold whose charge YeboPay reports FAILED', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([staleReserved()] as any);
    getChargeMock.mockResolvedValueOnce(buildCharge({ status: 'FAILED' }) as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any); // release

    const summary = await reclaimExpiredReservations();

    expect(summary).toMatchObject({ scanned: 1, released: 1, finalized: 0 });
    const release = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(release.data).toMatchObject({ status: 'available', userId: null });
  });

  it('LEAVES a still-PENDING hold held while within the hard-expiry window (never reclaim live money)', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([staleReserved({ reservedAt: minsAgo(20) })] as any);
    getChargeMock.mockResolvedValueOnce(buildCharge({ status: 'PENDING' }) as any);

    const summary = await reclaimExpiredReservations();

    expect(summary).toMatchObject({ scanned: 1, stillPending: 1, released: 0, finalized: 0 });
    // No release/finalize write — the seat stays held because the money may land.
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('reclaims a hold still PENDING past the hard-expiry window (charge is dead)', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([staleReserved({ reservedAt: minsAgo(90) })] as any);
    getChargeMock.mockResolvedValueOnce(buildCharge({ status: 'PENDING' }) as any);
    prismaMock.ticket.updateMany.mockResolvedValueOnce({ count: 1 } as any); // release

    const summary = await reclaimExpiredReservations();

    expect(summary).toMatchObject({ scanned: 1, released: 1 });
  });

  it('a YeboPay error while reconciling one hold leaves it held and is counted, not thrown', async () => {
    prismaMock.ticket.findMany.mockResolvedValueOnce([staleReserved()] as any);
    getChargeMock.mockRejectedValueOnce(new Error('YeboPay down'));

    const summary = await reclaimExpiredReservations();

    expect(summary).toMatchObject({ scanned: 1, errors: 1, released: 0, finalized: 0 });
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });
});

describe('getEventTicketsForCheckIn (offline scanner pre-sync)', () => {
  const requester = { id: 'org-1', role: 'organizer' };

  const grantEventAccess = (organizerId = 'org-1') =>
    prismaMock.event.findUnique.mockResolvedValue({ id: 'event-1', organizerId } as any);

  it('returns ONLY sold tickets, scoped to the event, in the gate DTO shape', async () => {
    grantEventAccess();
    prismaMock.ticket.findMany.mockResolvedValue([
      buildCheckInTicket(),
      buildCheckInTicket({ id: 'ticket-2', uniqueCode: 'DEF456', isCheckedIn: true }),
    ] as any);

    const result = await getEventTicketsForCheckIn('event-1', requester);

    // The query must constrain to this event AND status 'sold' so a forged or
    // non-sold code is never present in the cache the scanner trusts offline.
    const findArg = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(findArg.where).toMatchObject({ eventId: 'event-1', status: 'sold' });

    expect(result.count).toBe(2);
    expect(result.tickets).toHaveLength(2);
    expect(result.syncedAt).toEqual(expect.any(String));
    // isCheckedIn is preserved so the offline cache won't re-admit a used ticket.
    expect(result.tickets[0]).toMatchObject({ id: 'ticket-1', isCheckedIn: false });
    expect(result.tickets[1]).toMatchObject({ id: 'ticket-2', status: 'used', isCheckedIn: true });
  });

  it('REJECTS an organizer caching an event they do not own (no cross-tenant leak)', async () => {
    grantEventAccess('someone-else');

    await expect(getEventTicketsForCheckIn('event-1', requester)).rejects.toThrow(
      'You do not have permission to check in tickets for this event'
    );
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });

  it('404s for an unknown event', async () => {
    prismaMock.event.findUnique.mockResolvedValue(null);

    await expect(getEventTicketsForCheckIn('nope', requester)).rejects.toThrow('Event not found');
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});
