import { mockDeep, mockReset } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../yebopay.service', () => ({ createCharge: jest.fn(), getCharge: jest.fn(), YeboPayHttpError: class extends Error {} }));
jest.mock('../qr.service', () => ({ buildTicketQrPayload: jest.fn(() => ({})), generateTicketQrDataUrl: jest.fn(async () => 'QR') }));
jest.mock('../comms.service', () => ({ sendTextMessage: jest.fn(async () => ({})), sendEmailMessage: jest.fn() }));
import prisma from '../../config/prisma';
import { purchaseTicket, recoverPurchaseAttempt, handleChargeWebhookEvent } from '../ticket.service';
import { createCharge, getCharge } from '../yebopay.service';
import { sendTextMessage } from '../comms.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
const gateway = createCharge as jest.Mock;
const key = 'checkout-attempt-00001';
const payment = { idempotencyKey: key, providerCode: 'momo', phone: '+26878422613', country: 'SZ' };
let attempts: Map<string, any>, orders: Map<string, any>, tickets: any[], locks: Map<string, Promise<void>>;
let activeIdentityLocks: number;
const event = { id: 'event', title: 'Concert', isPublished: true, isCancelled: false, endDate: new Date('2099-01-01') };
const tier = { id: 'tier', eventId: 'event', price: 100, name: 'General', type: 'standard', saleStartDate: new Date(0), saleEndDate: new Date('2099-01-01'), event };
function matches(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([k, v]: any) => {
    if (k === 'OR') return v.some((w: any) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      if ('lte' in v) return row[k] <= v.lte;
    }
    return row[k] === v;
  });
}
beforeEach(() => {
  mockReset(db); jest.clearAllMocks();
  attempts = new Map(); orders = new Map(); locks = new Map(); activeIdentityLocks = 0;
  tickets = Array.from({length: 4}, (_, i) => ({ id: `seat-${i}`, uniqueCode: `code-${i}`, eventId: 'event', ticketTypeId: 'tier', userId: null,
    status: 'available', paymentRef: null, paymentStatus: null, event, ticketType: tier, user: { phoneNumber: '+26878422613' } }));
  db.ticketType.findUnique.mockResolvedValue(tier as any);
  db.ticketPurchaseAttempt.findUnique.mockImplementation(async ({where}: any) => attempts.get(where.key) || null);
  db.ticketPurchaseAttempt.create.mockImplementation(async ({data}: any) => {
    if (attempts.has(data.key)) throw new Error('duplicate identity');
    const row = {chargeId: null, failure: null, ...data}; attempts.set(data.key, row); return {...row};
  });
  db.ticketPurchaseAttempt.update.mockImplementation(async ({where, data}: any) => { Object.assign(attempts.get(where.key), data); return {...attempts.get(where.key)}; });
  db.ticketPurchaseAttempt.updateMany.mockImplementation(async ({where, data}: any) => {
    const rows = [...attempts.values()].filter(r => matches(r, where)); rows.forEach(r => Object.assign(r, data)); return {count: rows.length};
  });
  db.ticket.findFirst.mockImplementation(async ({where}: any) => tickets.find(t => matches(t, where)) as any || null);
  db.ticket.findMany.mockImplementation(async ({where}: any) => tickets.filter(t => matches(t, where)).map(t => ({...t})) as any);
  db.ticket.count.mockImplementation(async ({where}: any) => tickets.filter(t => matches(t, where)).length);
  db.ticket.updateMany.mockImplementation(async ({where, data}: any) => {
    const rows = tickets.filter(t => matches(t, where)); rows.forEach(t => Object.assign(t, data)); return {count: rows.length};
  });
  db.ticketOrderDelivery.upsert.mockImplementation(async ({where}: any) => {
    if (!orders.has(where.id)) orders.set(where.id, { id: where.id, status: 'pending', attempts: 0, attemptId: null, attemptedAt: null, nextAttemptAt: new Date(0) });
    return {...orders.get(where.id)};
  });
  db.ticketOrderDelivery.findUnique.mockImplementation(async ({where}: any) => ({...orders.get(where.id)}));
  db.ticketOrderDelivery.findUniqueOrThrow.mockImplementation(async ({where}: any) => ({...orders.get(where.id)}));
  db.ticketOrderDelivery.updateMany.mockImplementation(async ({where, data}: any) => {
    const row = orders.get(where.id);
    if (!row || !matches(row, where)) return {count: 0};
    Object.assign(row, data, {attempts: row.attempts + (data.attempts?.increment || 0)}); return {count: 1};
  });
  db.$transaction.mockImplementation(async (callback: any) => {
    let unlock: (() => void) | undefined;
    const tx = new Proxy(db, {get(target, prop) {
      if (prop !== '$queryRaw') return target[prop as keyof typeof target];
      return async (sql: TemplateStringsArray, identity: string) => {
        const query = sql.join('?');
        if (query.includes('pg_advisory_xact_lock')) {
          const previous = locks.get(identity) || Promise.resolve();
          locks.set(identity, new Promise<void>(resolve => { unlock = resolve; }));
          await previous; activeIdentityLocks++;
          return [];
        }
        if (query.includes('FROM "TicketType"')) return [tier];
        return [event];
      };
    }});
    try { return await callback(tx); } finally { if (unlock) {activeIdentityLocks--; unlock();} }
  });
  gateway.mockImplementation(async () => {
    expect(activeIdentityLocks).toBe(0); // identity transaction committed before external I/O
    expect(attempts.get(key)?.ticketIds).toHaveLength(2);
    return {id: 'charge', status: 'SUCCEEDED'};
  });
  (getCharge as jest.Mock).mockResolvedValue({ id: 'charge', status: 'PENDING' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const buy = (input = payment, user = 'buyer', quantity = 2, ticketType = 'tier') => purchaseTicket(ticketType, user, input, quantity);
function assertSingleOrder() {
  expect(gateway).toHaveBeenCalledTimes(1);
  expect(tickets.filter(t => t.userId === 'buyer')).toHaveLength(2);
  expect(orders.size).toBe(1);
  expect(sendTextMessage).toHaveBeenCalledTimes(1);
}
it('lost successful HTTP response: retry and reload recover exactly the original issued order', async () => {
  const committed = await buy(); // server committed; caller discards response
  const replay = await buy();
  const reload = await recoverPurchaseAttempt(key, 'buyer');
  expect(replay).toMatchObject(committed); expect(reload).toMatchObject(committed);
  assertSingleOrder();
});
it('serializes identical requests while the first gateway call remains in flight', async () => {
  let finish!: (value: any) => void;
  gateway.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const first = buy();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const replays = await Promise.all([buy(), buy(), recoverPurchaseAttempt(key, 'buyer')]);
  replays.forEach(r => expect(r).toMatchObject({pending: true, unknown: true}));
  expect(tickets.filter(t => t.userId === 'buyer')).toHaveLength(2);
  expect(gateway).toHaveBeenCalledTimes(1);
  finish({id: 'charge', status: 'SUCCEEDED'}); await first;
  assertSingleOrder();
});
it('pending charge replay keeps its original inventory and never dispatches again', async () => {
  gateway.mockResolvedValueOnce({id: 'charge', status: 'PENDING'});
  const first = await buy();
  const replay = await buy();
  expect(replay).toMatchObject({pending: true, paymentRef: 'charge'});
  expect(replay.tickets.map(t => t.id)).toEqual(first.tickets.map(t => t.id));
  expect(gateway).toHaveBeenCalledTimes(1); expect(orders.size).toBe(0);
  expect(tickets.filter(t => t.status === 'reserved')).toHaveLength(2);
});
it('gateway timeout then signed webhook settles the retained attempt and delivers once', async () => {
  gateway.mockRejectedValueOnce(new Error('gateway response lost'));
  await expect(buy()).rejects.toMatchObject({statusCode: 500});
  expect(await buy()).toMatchObject({pending: true, unknown: true});
  const description = `Tickets [yebotickets:${attempts.get(key).attemptRef}]`;
  await handleChargeWebhookEvent('charge.succeeded', {id: 'charge', description});
  await handleChargeWebhookEvent('charge.succeeded', {id: 'charge', description});
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject({pending: false});
  assertSingleOrder();
});
it.each([
  ['quantity', payment, 'buyer', 1, 'tier'],
  ['tier', payment, 'buyer', 2, 'other-tier'],
  ['payment intent', {...payment, phone: '+26876111111'}, 'buyer', 2, 'tier'],
  ['principal', payment, 'other-buyer', 2, 'tier'],
])('rejects changed %s with the same key', async (_label, input, user, qty, tierId) => {
  await buy();
  await expect(buy(input as any, user as string, qty as number, tierId as string)).rejects.toMatchObject({statusCode: 409});
  assertSingleOrder();
});
it('a recovery read closes an undispatched key, fencing a delayed original POST', async () => {
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject({failed: true, pending: false});
  await expect(buy()).rejects.toMatchObject({statusCode: 409});
  expect(gateway).not.toHaveBeenCalled(); expect(tickets.every(t => t.status === 'available')).toBe(true);
});
it('an explicit different key allows a deliberate second purchase', async () => {
  await buy();
  gateway.mockResolvedValueOnce({id: 'charge-two', status: 'SUCCEEDED'});
  await buy({...payment, idempotencyKey: 'checkout-attempt-00002'});
  expect(gateway).toHaveBeenCalledTimes(2); expect(orders.size).toBe(2);
  expect(tickets.filter(t => t.status === 'sold')).toHaveLength(4);
});
it('a declined attempt stays failed after seats have been released and reused', async () => {
  gateway.mockResolvedValueOnce({id: 'charge', status: 'FAILED'});
  await expect(buy()).rejects.toMatchObject({statusCode: 402});
  expect(await buy()).toMatchObject({failed: true, tickets: []});
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject({failed: true});
  expect(gateway).toHaveBeenCalledTimes(1); expect(tickets.every(t => t.status === 'available')).toBe(true);
});
it('free purchase retry also allocates and enqueues just once', async () => {
  db.ticketType.findUnique.mockResolvedValue({...tier, price: 0} as any);
  await buy(); await buy(); await recoverPurchaseAttempt(key, 'buyer');
  expect(gateway).not.toHaveBeenCalled(); expect(orders.size).toBe(1);
  expect(sendTextMessage).toHaveBeenCalledTimes(1);
  expect(tickets.filter(t => t.status === 'sold')).toHaveLength(2);
});
it('recovery repairs a crash after charge binding but before the ticket references were updated', async () => {
  gateway.mockRejectedValueOnce(new Error('response lost'));
  await expect(buy()).rejects.toThrow();
  attempts.get(key).chargeId = 'charge';
  (getCharge as jest.Mock).mockResolvedValue({id: 'charge', status: 'SUCCEEDED'});
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject({pending: false});
  assertSingleOrder();
});
it('a succeeded webhook winning before a PENDING create response cannot downgrade issuance', async () => {
  gateway.mockImplementationOnce(async (input: any) => {
    await handleChargeWebhookEvent('charge.succeeded', {id: 'charge', description: input.description});
    return {id: 'charge', status: 'PENDING'};
  });
  expect(await buy()).toMatchObject({pending: false});
  assertSingleOrder();
});
it('timeout then failed webhook releases the original holds and preserves a terminal failure', async () => {
  gateway.mockRejectedValueOnce(new Error('response lost'));
  await expect(buy()).rejects.toThrow();
  await handleChargeWebhookEvent('charge.failed', {id: 'charge', description: `Tickets [yebotickets:${attempts.get(key).attemptRef}]`});
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject({failed: true});
  expect(gateway).toHaveBeenCalledTimes(1); expect(orders.size).toBe(0);
  expect(tickets.every(t => t.status === 'available')).toBe(true);
});
it('missing identity is rejected without allocating or charging', async () => {
  await expect(purchaseTicket('tier', 'buyer', {providerCode: 'momo'}, 2)).rejects.toMatchObject({statusCode: 400});
  expect(attempts.size).toBe(0); expect(gateway).not.toHaveBeenCalled();
});

it('a failed webhook after successful issuance preserves the order on retry and reload', async () => {
  const issued = await buy();
  const description = `Tickets [yebotickets:${attempts.get(key).attemptRef}]`;
  expect(await handleChargeWebhookEvent('charge.failed', {id: 'charge', description}))
    .toMatchObject({result: 'already_final', status: 'sold'});
  // Redelivery of the contradictory event must also leave recovery unchanged.
  await handleChargeWebhookEvent('charge.failed', {id: 'charge', description});
  expect(attempts.get(key).failure).toBeNull();
  expect(await buy()).toMatchObject(issued);
  expect(await recoverPurchaseAttempt(key, 'buyer')).toMatchObject(issued);
  expect(tickets.filter(t => t.status === 'sold')).toHaveLength(2);
  assertSingleOrder();
});
