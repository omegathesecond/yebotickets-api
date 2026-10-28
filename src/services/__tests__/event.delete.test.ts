import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../yebopay.service', () => ({ createCharge: jest.fn(async () => ({ id: 'charge', status: 'PENDING' })) }));
import prisma from '../../config/prisma';
import { createCharge } from '../yebopay.service';
import { deleteEvent } from '../event.service';
import { deleteTicketType, generateTickets, purchaseTicket, updateTicketType } from '../ticket.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;

describe('atomic event deletion', () => {
  let event: any;
  let tickets: any[];
  let tail: Promise<void>;
  let writes: string[];
  let onLock: () => void;
  let receipt: any;
  let refund: any;
  let attempt: any;
  beforeEach(() => {
    mockReset(db);
    event = { id: 'event', organizerId: 'owner', isPublished: true, isCancelled: false, endDate: new Date('2099-01-01') };
    onLock = () => {};
    receipt = refund = attempt = null;
    tickets = [];
    writes = [];
    tail = Promise.resolve();
    const tier = () => ({ id: 'tier', eventId: 'event', quantity: 5, price: 100, type: 'standard', event, saleStartDate: new Date('2000-01-01'), saleEndDate: new Date('2099-01-01') });
    db.ticketType.findUnique.mockImplementation(async () => tier() as any);
    db.ticket.findMany.mockImplementation(async ({ where }: any) => where.reservedAt ? [] : tickets);
    db.ticketPurchaseAttempt.update.mockResolvedValue({} as any);
    db.ticket.updateMany.mockImplementation(async ({ data }: any) => { tickets.forEach(t => Object.assign(t, data)); return { count: tickets.length }; });
    db.$transaction.mockImplementation(async (callback: any) => {
      let release: (() => void) | undefined;
      const tx: any = {
        $queryRaw: async (sql: TemplateStringsArray, ...values: any[]) => {
          if (sql.join('').includes('TicketPurchaseAttempt')) {
            // Mirror the SQL join: removing referenced inventory would make
            // the later event check blind to a released purchase attempt.
            const [eventId, ticketTypeId] = values;
            return attempt && tickets.some(t => attempt.ticketIds.includes(t.id) &&
              t.eventId === eventId && (!ticketTypeId || t.ticketTypeId === ticketTypeId)) ? [attempt] : [];
          }
          if (sql.join('').includes('pg_advisory')) return [];
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
          delete: async () => { writes.push('tier'); },
          update: async ({ data }: any) => ({ ...tier(), ...data }),
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
        ticketPurchaseAttempt: {
          findUnique: async () => null,
          updateMany: async ({ data }: any) => { Object.assign(attempt, data); return { count: 1 }; },
          create: async ({ data }: any) => { attempt = data; return data; },
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
  it.each([true, false])('serializes tier edits versus deletion (delete first %s)', async deleteFirst => {
    const locked = new Promise<void>(resolve => { onLock = resolve; });
    const edit = () => updateTicketType('tier', { quantity: 10 }, 'owner');
    const first = deleteFirst ? deleteEvent('event', 'owner') : edit();
    await locked;
    const second = deleteFirst ? edit() : deleteEvent('event', 'owner');
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    if (deleteFirst) expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 404 } });
    else expect(results[1].status).toBe('fulfilled');
    expect(event).toBeNull();
    expect(tickets).toEqual([]);
  });
  it.each(['receipt', 'refund', 'attempt'])('retains independent %s history', async kind => {
    if (kind === 'receipt') receipt = { opId: 'admission' };
    else if (kind === 'refund') refund = { chargeId: 'charge' };
    else {
      tickets = [{ id: 'ticket', eventId: 'event', ticketTypeId: 'tier', status: 'available' }];
      attempt = { key: 'released-purchase', ticketIds: ['ticket'] };
    }
    await expect(deleteEvent('event', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(writes).toEqual([]);
  });
  it('deletes an unused tier atomically', async () => {
    tickets = [{ id: 'ticket', status: 'available' }];
    await expect(deleteTicketType('tier', 'owner')).resolves.toHaveProperty('message');
    expect(writes).toEqual(['inventory', 'tier']);
  });
  it('rejects tier deletion by a nonowner', async () => {
    await expect(deleteTicketType('tier', 'other')).rejects.toMatchObject({ statusCode: 403 });
    expect(writes).toEqual([]);
  });
  it.each(['sold', 'reserved', 'cancelled'])('preserves %s tier inventory', async status => {
    tickets = [{ id: 'ticket', status }];
    await expect(deleteTicketType('tier', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(tickets).toHaveLength(1);
    expect(writes).toEqual([]);
  });
  it('preserves failed purchase history through release, tier deletion and event deletion', async () => {
    tickets = [{ id: 'ticket', eventId: 'event', ticketTypeId: 'tier', status: 'available' }];
    (createCharge as jest.Mock).mockResolvedValueOnce({ id: 'charge', status: 'FAILED' });
    await expect(purchaseTicket('tier', 'buyer', {
      providerCode: 'momo', idempotencyKey: 'delete-failed-purchase-01',
    })).rejects.toMatchObject({ statusCode: 402 });
    expect(tickets[0]).toMatchObject({ status: 'available', userId: null, paymentRef: null });
    expect(attempt).toMatchObject({ ticketIds: ['ticket'], failure: expect.any(String) });
    await expect(deleteTicketType('tier', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteEvent('event', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    expect(tickets).toHaveLength(1);
    expect(event).toBeTruthy();
    expect(writes).toEqual([]);
  });
  it.each([true, false])('serializes checkout versus deletion (delete first %s)', async deleteFirst => {
    tickets = [{ id: 'ticket', eventId: 'event', status: 'available' }];
    const locked = new Promise<void>(resolve => { onLock = resolve; });
    const buy = () => purchaseTicket('tier', 'buyer', { providerCode: 'momo', idempotencyKey: 'delete-race-purchase-01' });
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
