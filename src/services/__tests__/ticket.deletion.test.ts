import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../yebopay.service', () => ({ createCharge: jest.fn(), YeboPayHttpError: class extends Error {} }));
import prisma from '../../config/prisma';
import { deleteTicketType, generateTickets, purchaseTicket } from '../ticket.service';
import { createCharge } from '../yebopay.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
const event = { id: 'event', isPublished: true, isCancelled: false, endDate: new Date('2099-01-01') };
let tier: any, tickets: any[], attempts: any[], refunds: any[], admissions: any[];
let tail: Promise<void>, failDelete: boolean, mutations: number;
let onTierLock: (() => void) | undefined;
const unused = (id = 'seat') => ({ id, ticketTypeId: 'tier', eventId: 'event', status: 'available', isCheckedIn: false,
  ...Object.fromEntries(['userId', 'purchaseDate', 'reservedAt', 'paymentRef', 'paymentStatus', 'amountPaid',
    'deliveryOrderId', 'refundRef', 'refundedAt', 'cancelledAt', 'refundRequestedAt', 'refundRequestReason', 'checkedInAt'].map(k => [k, null])) });
function matches(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([key, value]: any) => {
    if (key === 'OR') return value.some((w: any) => matches(row, w));
    if (value && typeof value === 'object') {
      if ('not' in value) return value.not === null ? row[key] != null : row[key] !== value.not;
      if ('in' in value) return value.in.includes(row[key]);
      if ('hasSome' in value) return row[key].some((id: string) => value.hasSome.includes(id));
    }
    return row[key] === value;
  });
}
beforeEach(() => {
  mockReset(db);
  tier = { id: 'tier', eventId: 'event', quantity: 5, price: 100, type: 'standard', event,
    saleStartDate: new Date(0), saleEndDate: new Date('2099-01-01') };
  tickets = [unused()]; attempts = []; refunds = []; admissions = [];
  onTierLock = undefined; tail = Promise.resolve(); failDelete = false; mutations = 0;
  db.ticketType.findUnique.mockImplementation(async () => tier && { ...tier });
  db.event.findFirst.mockImplementation(async ({where}: any) => where.organizerId === 'owner' ? event as any : null);
  db.ticket.findMany.mockImplementation(async ({where}: any) => tickets.filter(t => matches(t, where)).map(t => ({...t, event})));
  db.ticket.findFirst.mockImplementation(async ({where}: any) => tickets.find(t => matches(t, where)) || null);
  db.ticket.count.mockImplementation(async ({where}: any) => tickets.filter(t => matches(t, where)).length);
  db.ticket.deleteMany.mockImplementation(async ({where}: any) => {
    mutations++; const before = tickets.length; tickets = tickets.filter(t => !matches(t, where)); return { count: before - tickets.length };
  });
  db.ticketType.delete.mockImplementation(async () => {
    mutations++; if (failDelete) throw new Error('final deletion failed'); const deleted = tier; tier = null; return deleted;
  });
  db.ticket.createMany.mockImplementation(async ({data}: any) => { mutations++; tickets.push(...data); return {count: data.length}; });
  db.ticket.updateMany.mockImplementation(async ({where, data}: any) => {
    const rows = tickets.filter(t => matches(t, where)); rows.forEach(t => Object.assign(t, data)); return {count: rows.length};
  });
  db.ticketPurchaseAttempt.findFirst.mockImplementation(async ({where}: any) => attempts.find(t => matches(t, where)) || null);
  db.ticketRefundLock.findFirst.mockImplementation(async ({where}: any) => refunds.find(t => matches(t, where)) || null);
  db.ticketAdmissionReceipt.findFirst.mockImplementation(async ({where}: any) => admissions.find(t => matches(t, where)) || null);
  db.ticketPurchaseAttempt.findUnique.mockResolvedValue(null);
  db.ticketPurchaseAttempt.create.mockImplementation(async ({data}: any) => { attempts.push(data); return data; });
  // Model the conflicting tier locks used by the actual deletion, generation,
  // and purchase functions. Snapshot after lock acquisition; restore on abort.
  db.$transaction.mockImplementation(async (callback: any) => {
    let release: (() => void) | undefined, snapshot: any;
    const tx = new Proxy(db, {get(target, prop) {
      if (prop !== '$queryRaw') return target[prop as keyof typeof target];
      return async (sql: TemplateStringsArray) => {
        const query = sql.join('?');
        if (query.includes('FROM "TicketType"')) {
          expect(query).toMatch(/FOR (UPDATE|SHARE)/);
          const previous = tail; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
          onTierLock?.();
          snapshot = {tier, tickets: tickets.map(t => ({...t})), attempts: [...attempts]};
          return tier ? [tier] : [];
        }
        return [event];
      };
    }});
    try { return await callback(tx); }
    catch (error) { if (snapshot) { tier = snapshot.tier; tickets = snapshot.tickets; attempts = snapshot.attempts; } throw error; }
    finally { release?.(); }
  });
  (createCharge as jest.Mock).mockRejectedValue(new Error('gateway outcome unknown'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const remove = () => deleteTicketType('tier', 'owner');

it.each(['sold', 'reserved', 'cancelled'])('rejects %s history alongside inventory without any mutation', async status => {
  tickets.push({...unused('history'), status, ...(status === 'cancelled' ? {
    paymentStatus: 'REFUNDED', paymentRef: 'charge', refundRef: 'refund', refundedAt: new Date(), amountPaid: 100,
  } : {})}); const before = structuredClone(tickets);
  await expect(remove()).rejects.toMatchObject({statusCode: 409});
  expect(tickets).toEqual(before); expect(mutations).toBe(0); expect(tier).not.toBeNull();
});
it.each(['userId', 'purchaseDate', 'reservedAt', 'paymentRef', 'paymentStatus', 'amountPaid', 'deliveryOrderId',
  'refundRef', 'refundedAt', 'cancelledAt', 'refundRequestedAt', 'refundRequestReason', 'checkedInAt', 'isCheckedIn'])(
  'protects available rows carrying %s', async field => {
    tickets[0][field] = field === 'amountPaid' ? 0 : field === 'isCheckedIn' ? true : 'recorded';
    const before = structuredClone(tickets);
    await expect(remove()).rejects.toMatchObject({statusCode: 409});
    expect(tickets).toEqual(before); expect(mutations).toBe(0);
  });
it.each(['purchase', 'refund', 'admission'])('protects durable %s references on released available rows', async kind => {
  if (kind === 'purchase') attempts.push({key: 'key', ticketIds: ['seat']});
  if (kind === 'refund') refunds.push({chargeId: 'charge', ticketId: 'seat'});
  if (kind === 'admission') admissions.push({opId: 'operation', ticketId: 'seat'});
  const before = structuredClone({tickets, attempts, refunds, admissions});
  await expect(remove()).rejects.toMatchObject({statusCode: 409});
  expect({tickets, attempts, refunds, admissions}).toEqual(before); expect(mutations).toBe(0);
});
it('rolls back inventory if final tier deletion fails', async () => {
  failDelete = true; const before = structuredClone(tickets);
  await expect(remove()).rejects.toMatchObject({statusCode: 500});
  expect(tickets).toEqual(before); expect(tier).not.toBeNull(); expect(mutations).toBe(2);
});
it.each([0, 3])('deletes a genuinely unused tier with %s tickets', async count => {
  tickets = Array.from({length: count}, (_, i) => unused(String(i)));
  await expect(remove()).resolves.toMatchObject({message: 'Ticket type deleted successfully'});
  expect(tickets).toEqual([]); expect(tier).toBeNull();
});
it('rejects other organisers and missing tiers before mutation', async () => {
  await expect(deleteTicketType('tier', 'intruder')).rejects.toMatchObject({statusCode: 403});
  expect(mutations).toBe(0); tier = null;
  await expect(remove()).rejects.toMatchObject({statusCode: 404}); expect(mutations).toBe(0);
});
it.each([true, false])('serializes deletion with generation (delete first: %s)', async deleteFirst => {
  const generate = () => generateTickets('tier', 2, 'owner');
  const results = await Promise.allSettled(deleteFirst ? [remove(), generate()] : [generate(), remove()]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe(deleteFirst ? 'rejected' : 'fulfilled');
  expect(tier).toBeNull(); expect(tickets).toEqual([]);
});
it.each([true, false])('serializes deletion with actual purchase reservation (delete first: %s)', async deleteFirst => {
  const buy = () => purchaseTicket('tier', 'buyer', {idempotencyKey: 'checkout-attempt-00001', providerCode: 'momo', phone: '+26878422613', country: 'SZ'});
  // Start the second operation while the first holds the real tier lock.
  const locked = new Promise<void>(resolve => { onTierLock = resolve; });
  const first = deleteFirst ? remove() : buy();
  await locked;
  const results = await Promise.allSettled([first, deleteFirst ? buy() : remove()]);
  if (deleteFirst) {
    expect(results[0].status).toBe('fulfilled'); expect(tier).toBeNull(); expect(tickets).toEqual([]);
    expect(createCharge).not.toHaveBeenCalled();
  } else {
    expect(results[1]).toMatchObject({status: 'rejected', reason: {statusCode: 409}});
    expect(tier).not.toBeNull(); expect(tickets[0].status).toBe('reserved'); expect(attempts).toHaveLength(1);
    expect(mutations).toBe(0);
  }
  expect(results[deleteFirst ? 1 : 0].status).toBe('rejected');
});
