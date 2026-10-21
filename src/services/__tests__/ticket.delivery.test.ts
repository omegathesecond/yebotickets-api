import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../comms.service', () => ({ sendTextMessage: jest.fn(), sendEmailMessage: jest.fn() }));
jest.mock('../qr.service', () => ({ buildTicketQrPayload: jest.fn(), generateTicketQrDataUrl: jest.fn() }));
import prisma from '../../config/prisma';
import { dispatchOrderDelivery, recoverOrderDeliveries, retryTicketOrderDelivery, getUserTickets } from '../ticket.service';
import { sendTextMessage } from '../comms.service';
import { YeboLinkSendError } from '../yebolink.client';
const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const send = sendTextMessage as jest.Mock;
let row: any;
let tickets: any[];
beforeEach(() => {
  mockReset(db); send.mockReset(); send.mockResolvedValue({ messageId: 'msg', status: 'queued' });
  row = { id: 'paid:charge', status: 'pending', attempts: 0, attemptId: null, attemptedAt: null,
    channel: null, error: null, nextAttemptAt: new Date(0) };
  tickets = ['ONE', 'TWO'].map(uniqueCode => ({ id: uniqueCode, eventId: 'event', userId: 'buyer',
    uniqueCode, deliveryOrderId: row.id, status: 'sold', paymentStatus: 'SUCCEEDED', paymentRef: 'charge',
    event: { title: 'Concert', startDate: new Date(), isCancelled: false }, ticketType: { name: 'Standard' },
    user: { phoneNumber: '+26878422613' } }));
  db.$transaction.mockImplementation(((fn: any) => fn(db)) as any);
  db.$queryRaw.mockImplementation((async () => [{ isCancelled: tickets[0]?.event.isCancelled }]) as any);
  db.ticket.findMany.mockImplementation(async () => tickets);
  db.ticket.findUnique.mockImplementation(async ({where}: any) => tickets.find(t => t.id === where.id));
  db.ticket.count.mockResolvedValue(0);
  db.ticketOrderDelivery.findUnique.mockImplementation(async () => ({...row}));
  db.ticketOrderDelivery.findUniqueOrThrow.mockImplementation(async () => ({...row}));
  db.ticketOrderDelivery.findMany.mockImplementation(async () => ['pending','failed'].includes(row.status) ? [{...row}] : []);
  db.ticketOrderDelivery.updateMany.mockImplementation(async ({where, data}: any) => {
    if (where.id && where.id !== row.id || where.status && row.status !== where.status ||
        'attemptId' in where && where.attemptId !== row.attemptId ||
        where.attemptedAt && !(row.attemptedAt < where.attemptedAt.lt)) return {count: 0};
    Object.assign(row, data, {attempts: row.attempts + (data.attempts?.increment || 0)});
    return {count: 1};
  });
});

test('restart recovers issuance committed before dispatch, sending the whole order once', async () => {
  await recoverOrderDeliveries();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toContain('ONE');
  expect(send.mock.calls[0][1]).toContain('TWO');
  expect(row.status).toBe('sent');
  await recoverOrderDeliveries();
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.ticket.updateMany).not.toHaveBeenCalled();
});
test('rejection is durably failed, remains visible in wallet, and a manual retry records success', async () => {
  send.mockRejectedValueOnce(new YeboLinkSendError('rate limited', false));
  expect((await dispatchOrderDelivery(row.id)).status).toBe('failed');
  expect(row.status).toBe('failed');
  db.ticket.findMany.mockResolvedValue(tickets.map(t => ({...t, deliveryOrder: {...row}})));
  expect((await getUserTickets('buyer'))[0].delivery?.status).toBe('failed');
  row.attemptedAt = new Date(Date.now() - 61_000);
  expect((await retryTicketOrderDelivery('ONE', 'buyer')).status).toBe('sent');
  expect(row.status).toBe('sent');
});
test('concurrent worker and manual retry normally dispatch only once', async () => {
  await Promise.all([dispatchOrderDelivery(row.id), dispatchOrderDelivery(row.id, true)]);
  expect(send).toHaveBeenCalledTimes(1);
});
test('lost acknowledgement is unknown, no automatic fallback or resend; explicit retry accepts duplicate risk', async () => {
  send.mockRejectedValueOnce(new Error('socket disconnected after acceptance'));
  expect((await dispatchOrderDelivery(row.id)).status).toBe('unknown');
  await recoverOrderDeliveries();
  expect(send).toHaveBeenCalledTimes(1);
  row.attemptedAt = new Date(Date.now() - 61_000);
  await expect(retryTicketOrderDelivery('ONE', 'buyer')).rejects.toMatchObject({ statusCode: 409 });
  await retryTicketOrderDelivery('ONE', 'buyer', true);
  expect(send).toHaveBeenCalledTimes(2);
  expect(row.status).toBe('sent');
});
test('crash during dispatch becomes unknown after restart, never automatically reclaims the send', async () => {
  Object.assign(row, { status: 'sending', attemptedAt: new Date(Date.now() - 180_000), attemptId: 'crashed' });
  await recoverOrderDeliveries();
  expect(row.status).toBe('unknown');
  expect(send).not.toHaveBeenCalled();
});
test('ownership and persistent cooldown gate retries before dispatch', async () => {
  await expect(retryTicketOrderDelivery('ONE', 'stranger')).rejects.toMatchObject({ statusCode: 404 });
  row.attemptedAt = new Date(); row.status = 'failed';
  await expect(retryTicketOrderDelivery('ONE', 'buyer')).rejects.toMatchObject({ statusCode: 429 });
  expect(send).not.toHaveBeenCalled();
});
test('cancelled events, refunded tickets and refund claims never send admission messages', async () => {
  tickets[0].event.isCancelled = true;
  expect((await dispatchOrderDelivery(row.id)).status).toBe('suppressed');
  row.status = 'pending'; tickets.forEach(t => { t.event.isCancelled = false; t.status = 'cancelled'; });
  expect((await dispatchOrderDelivery(row.id)).status).toBe('suppressed');
  row.status = 'pending'; tickets.forEach(t => { t.status = 'sold'; });
  db.ticketRefundLock.findUnique.mockResolvedValue({ chargeId: 'charge' } as any);
  expect((await dispatchOrderDelivery(row.id)).status).toBe('failed');
  expect(send).not.toHaveBeenCalled();
});
test('partial refund retry sends every remaining eligible ticket only', async () => {
  tickets[0].status = 'cancelled';
  await retryTicketOrderDelivery('TWO', 'buyer');
  expect(send.mock.calls[0][1]).toContain('TWO');
  expect(send.mock.calls[0][1]).not.toContain('ONE');
});

test('lost database acknowledgement after provider acceptance stays recoverable and never invents sent state', async () => {
  const implementation = db.ticketOrderDelivery.updateMany.getMockImplementation()!;
  db.ticketOrderDelivery.updateMany.mockImplementation(async (args: any) => {
    if (args.data.status === 'sent') throw new Error('database connection lost');
    return implementation(args);
  });
  await expect(dispatchOrderDelivery(row.id)).rejects.toThrow('database connection lost');
  expect(row.status).toBe('sending');
  row.attemptedAt = new Date(Date.now() - 180_000);
  await recoverOrderDeliveries();
  expect(row.status).toBe('unknown');
  expect(send).toHaveBeenCalledTimes(1);
  expect(db.ticket.updateMany).not.toHaveBeenCalled();
});
