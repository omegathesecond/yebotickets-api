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
  it('sells an available ticket: marks it sold, sets userId and purchaseDate', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(buildTicketType() as any);
    prismaMock.ticket.findFirst.mockResolvedValue(buildAvailableTicket() as any);
    prismaMock.ticket.update.mockResolvedValue(buildSoldTicketWithRelations() as any);

    const result = await purchaseTicket('tt-1', 'user-1');

    // The mutation persists the sale with the buyer and a fresh purchaseDate.
    expect(prismaMock.ticket.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.ticket.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 'ticket-1' });
    expect(updateArg.data).toMatchObject({
      userId: 'user-1',
      status: 'sold',
      purchaseDate: expect.any(Date),
    });

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

    // No sale must be attempted when nothing is available.
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
  });

  it('throws on an unknown ticketTypeId', async () => {
    prismaMock.ticketType.findUnique.mockResolvedValue(null);

    await expect(purchaseTicket('does-not-exist', 'user-1')).rejects.toMatchObject({
      message: 'Ticket type not found',
      statusCode: 404,
    });

    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.ticket.update).not.toHaveBeenCalled();
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
