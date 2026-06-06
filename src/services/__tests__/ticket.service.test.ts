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
// the unit under test stays focused on the sell/check-in logic and never makes
// a network call or renders a real image.
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

// Imports must come AFTER the jest.mock calls so the mocked modules are wired in.
import prisma from '../../config/prisma';
import { purchaseTicket, verifyTicket } from '../ticket.service';
import { sendImageMessage } from '../whatsapp.service';
import { TicketStatus } from '../../interfaces/ticket.interface';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;
const sendImageMessageMock = sendImageMessage as jest.MockedFunction<typeof sendImageMessage>;

beforeEach(() => {
  // Reset return-value stubs between tests (clearMocks in jest.config only
  // clears call records, not the implementations jest-mock-extended installs).
  mockReset(prismaMock);
  sendImageMessageMock.mockResolvedValue({ ok: true } as any);
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
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

// A ticket as returned by prisma.ticket.update with PURCHASE_INCLUDE relations.
const buildSoldTicketWithRelations = (over: Partial<any> = {}) => ({
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

describe('purchaseTicket', () => {
  it('atomically claims an available ticket: guarded updateMany sets sold/userId/purchaseDate', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 'ticket-1' } as any);
    // count === 1 -> this buyer won the row.
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.ticket.findUnique.mockResolvedValue(buildSoldTicketWithRelations() as any);

    const result = await purchaseTicket('tt-1', 'user-1');

    // The claim is a CONDITIONAL update: it only matches while the row is still
    // available and unowned — this is what makes concurrent claims safe.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(claimArg.where).toEqual({ id: 'ticket-1', status: 'available', userId: null });
    expect(claimArg.data).toMatchObject({
      userId: 'user-1',
      status: 'sold',
      purchaseDate: expect.any(Date),
    });
    // A plain unconditional update by id would reintroduce the race — forbid it.
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();

    // The returned ticket reflects the sale and carries a QR for the buyer.
    expect(result.status).toBe(TicketStatus.SOLD);
    expect(result.userId).toBe('user-1');
    expect(result.purchaseDate).toBeInstanceOf(Date);
    expect(result.qrCode).toBe('data:image/png;base64,FAKEQR');
    expect(result.delivery).toEqual({ channel: 'whatsapp', status: 'sent' });
  });

  it('throws when no available ticket exists for the ticket type', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue(null);

    await expect(purchaseTicket('tt-1', 'user-1')).rejects.toMatchObject({
      message: 'No tickets available for this ticket type',
      statusCode: 400,
    });

    // No claim must be attempted when nothing is available.
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
  });

  it('fails the loser of a concurrent race: a guarded claim on an already-claimed row matches no rows', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    // Buyer reads ticket-1 as available, but by the time the guarded claim runs
    // another buyer has already taken it, so updateMany matches 0 rows. With no
    // other ticket free, the retry finds nothing and the buyer is refused.
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ id: 'ticket-1' } as any) // looked available...
      .mockResolvedValueOnce(null); // ...but the pool is now exhausted on retry
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 } as any);

    await expect(purchaseTicket('tt-1', 'user-2')).rejects.toMatchObject({
      message: 'No tickets available for this ticket type',
      statusCode: 400,
    });

    // It DID attempt the guarded claim and lost (count 0), then never fabricated
    // a sale — findUnique (the post-win re-fetch) must not run for a loser.
    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = prismaMock.ticket.updateMany.mock.calls[0][0];
    expect(claimArg.where).toEqual({ id: 'ticket-1', status: 'available', userId: null });
    expect(prismaMock.ticket.findUnique).not.toHaveBeenCalled();
  });

  it('retries past a lost row and claims the next available ticket instead of failing', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    // First candidate ticket-1 is stolen mid-claim (count 0); the loop must move
    // on to ticket-2 and win it rather than wrongly reporting "sold out".
    prismaMock.ticket.findFirst
      .mockResolvedValueOnce({ id: 'ticket-1' } as any)
      .mockResolvedValueOnce({ id: 'ticket-2' } as any);
    prismaMock.ticket.updateMany
      .mockResolvedValueOnce({ count: 0 } as any) // lost ticket-1
      .mockResolvedValueOnce({ count: 1 } as any); // won ticket-2
    prismaMock.ticket.findUnique.mockResolvedValue(
      buildSoldTicketWithRelations({ id: 'ticket-2' }) as any
    );

    const result = await purchaseTicket('tt-1', 'user-3');

    expect(prismaMock.ticket.updateMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.ticket.updateMany.mock.calls[1][0].where).toEqual({
      id: 'ticket-2',
      status: 'available',
      userId: null,
    });
    expect(result.status).toBe(TicketStatus.SOLD);
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
      Object.assign(row, args.data); // atomic flip: available -> sold
      return { count: 1 } as any;
    });
    prismaMock.ticket.findUnique.mockImplementation(async (args: any) => {
      const row = rows.find(r => r.id === args.where.id);
      return row ? (buildSoldTicketWithRelations({ ...row }) as any) : null;
    });

    const outcomes = await Promise.allSettled([
      purchaseTicket('tt-1', 'user-1'),
      purchaseTicket('tt-1', 'user-2'),
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

    // The single row ended up sold to exactly one user, never double-allocated.
    expect(rows[0].status).toBe('sold');
    expect(['user-1', 'user-2']).toContain(rows[0].userId);
  });

  it('throws on an unknown ticketTypeId', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(null);

    await expect(purchaseTicket('does-not-exist', 'user-1')).rejects.toMatchObject({
      message: 'Ticket type not found',
      statusCode: 404,
    });

    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled();
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
