import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../yebopay.service', () => ({ createCharge: jest.fn(async () => ({ id: 'charge', status: 'PENDING' })) }));
import prisma from '../../config/prisma';
import { createCharge } from '../yebopay.service';
import { deleteEvent } from '../event.service';
import { generateTickets, purchaseTicket } from '../ticket.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;

describe('atomic event deletion', () => {
  let event: any;
  let tickets: any[];
  let tail: Promise<void>;
  let writes: string[];
  let onLock: () => void;
  let receipt: any;
  let refund: any;
  beforeEach(() => {
    mockReset(db);
    event = { id: 'event', organizerId: 'owner', isPublished: true, isCancelled: false, endDate: new Date('2099-01-01') };
    onLock = () => {};
    receipt = refund = null;
    tickets = [];
    writes = [];
    tail = Promise.resolve();
    const tier = () => ({ id: 'tier', eventId: 'event', quantity: 5, price: 100, type: 'standard', event, saleStartDate: new Date('2000-01-01'), saleEndDate: new Date('2099-01-01') });
    db.ticketType.findUnique.mockImplementation(async () => tier() as any);
    db.ticket.findMany.mockImplementation(async ({ where }: any) => where.reservedAt ? [] : tickets);
    db.ticket.updateMany.mockImplementation(async ({ data }: any) => { tickets.forEach(t => Object.assign(t, data)); return { count: tickets.length }; });
    db.$transaction.mockImplementation(async (callback: any) => {
      let release: (() => void) | undefined;
      const tx: any = {
        $queryRaw: async (sql: TemplateStringsArray) => {
          if (sql.join('').includes('TicketRefundLock')) return refund ? [refund] : [];
          if (sql.join('').includes('FROM "Event"')) {
            const previous = tail;
            tail = new Promise<void>(resolve => { release = resolve; });
            await previous;
            onLock();
            return event ? [event] : [];
          }
          return event ? [tier()] : [];
        },
        event: {
          findFirst: async ({ where }: any) => event?.organizerId === where.organizerId ? event : null,
          delete: async () => { expect(tickets).toHaveLength(0); writes.push('event'); event = null; },
        },
        ticketType: {
          findUnique: async () => tier(),
          deleteMany: async () => { writes.push('tiers'); },
        },
        ticket: {
          findFirst: async ({ where }: any) => tickets.find(t => where.OR ? where.OR.some((clause: any) => {
            const [key, value] = Object.entries(clause)[0];
            return typeof value === 'object' ? (value as any).not === null ? t[key] != null : t[key] !== (value as any).not : t[key] === value;
          }) : t.status === 'available'),
          updateMany: async ({ data }: any) => { Object.assign(tickets[0], data); return { count: 1 }; },
          findMany: async () => tickets,
          deleteMany: async () => { writes.push('inventory'); tickets = []; },
          count: async () => tickets.length,
          createMany: async ({ data }: any) => { expect(event).toBeTruthy(); tickets.push(...data); return { count: data.length }; },
        },
        ticketAdmissionReceipt: { findFirst: async () => receipt },
        ticketRefundLock: { findFirst: async () => refund },
      };
      try { return await callback(tx); } finally { release?.(); }
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([0, 3])('deletes %s unused tickets before tiers and event', async count => {
    tickets = Array.from({ length: count }, () => ({ status: 'available' }));
    await expect(deleteEvent('event', 'owner')).resolves.toHaveProperty('message');
    expect(writes).toEqual(['inventory', 'tiers', 'event']);
  });
  it('rejects nonowners without writes', async () => {
    await expect(deleteEvent('event', 'other')).rejects.toMatchObject({ statusCode: 404 });
    expect(writes).toEqual([]);
  });
  it.each([
    { status: 'sold' }, { status: 'reserved' }, { status: 'cancelled' },
    ...['userId', 'purchaseDate', 'paymentRef', 'paymentStatus', 'amountPaid', 'deliveryOrderId',
      'refundRef', 'refundedAt', 'cancelledAt', 'refundRequestedAt', 'refundRequestReason', 'checkedInAt', 'reservedAt']
      .map(key => ({ status: 'available', [key]: 'history' })),
    { status: 'available', isCheckedIn: true },
  ])('preserves history %j', async ticket => {
    tickets = [ticket];
    await expect(deleteEvent('event', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(writes).toEqual([]);
    expect(tickets).toEqual([ticket]);
    expect(event).toBeTruthy();
  });
  it.each([true, false])('serializes generation and deletion (delete first %s)', async deleteFirst => {
    const remove = () => deleteEvent('event', 'owner');
    const generate = () => generateTickets('tier', 2, 'owner');
    const locked = new Promise<void>(resolve => { onLock = resolve; });
    const first = deleteFirst ? remove() : generate();
    await locked;
    const second = deleteFirst ? generate() : remove();
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    if (deleteFirst) expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 404 } });
    else expect(results[1].status).toBe('fulfilled');
    expect(event).toBeNull();
    expect(tickets).toEqual([]);
  });
  it.each(['receipt', 'refund'])('retains independent %s history', async kind => {
    if (kind === 'receipt') receipt = { opId: 'admission' };
    else refund = { chargeId: 'charge' };
    await expect(deleteEvent('event', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(writes).toEqual([]);
  });
  it.each([true, false])('serializes checkout versus deletion (delete first %s)', async deleteFirst => {
    tickets = [{ id: 'ticket', eventId: 'event', status: 'available' }];
    const locked = new Promise<void>(resolve => { onLock = resolve; });
    const buy = () => purchaseTicket('tier', 'buyer', { providerCode: 'momo' });
    const first = deleteFirst ? deleteEvent('event', 'owner') : buy();
    await locked;
    const second = deleteFirst ? buy() : deleteEvent('event', 'owner');
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    if (deleteFirst) {
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 404 } });
      expect(createCharge).not.toHaveBeenCalled();
      expect(tickets).toEqual([]);
    } else {
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } });
      expect(tickets[0]).toMatchObject({ status: 'reserved', userId: 'buyer', paymentRef: 'charge' });
      expect(event).toBeTruthy();
      expect(writes).toEqual([]);
    }
  });

});
