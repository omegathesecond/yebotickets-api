/** Run only against a disposable DB initialized with prisma db push:
 * EVENT_DELETION_TEST_DATABASE_URL=postgresql://... npm test -- --runInBand event.deletion.postgres
 * Real PostgreSQL locks/FKs; all gateway and delivery calls are mocked. */
import { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true,
  default: new (require('@prisma/client').PrismaClient)({ datasources: {
    db: { url: process.env.EVENT_DELETION_TEST_DATABASE_URL || 'postgresql://unused:unused@localhost/unused' }
  } })
}));
jest.mock('../yebopay.service', () => ({ createCharge: jest.fn(), getCharge: jest.fn(), YeboPayHttpError: class extends Error {} }));
jest.mock('../comms.service', () => ({ sendTextMessage: jest.fn(), sendEmailMessage: jest.fn() }));
import db from '../../config/prisma';
import { deleteEvent } from '../event.service';
import { deleteTicketType, generateTickets, purchaseTicket, updateTicketType, createTicketType } from '../ticket.service';
import { createCharge } from '../yebopay.service';
const suite = process.env.EVENT_DELETION_TEST_DATABASE_URL ? describe : describe.skip;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
suite('event deletion with PostgreSQL', () => {
  let owner: string, buyer: string, eventId: string, tierId: string;
  const payment = { idempotencyKey: 'delete-regression-purchase', providerCode: 'momo', phone: '+26878422613' };
  beforeEach(async () => {
    // This suite owns its explicitly supplied disposable database.
    await db.$executeRawUnsafe('TRUNCATE "User", "Event", "TicketType", "Ticket", "TicketPurchaseAttempt", "TicketRefundLock", "TicketAdmissionReceipt", "TicketOrderDelivery" CASCADE');
    owner = (await db.user.create({ data: { name: 'Owner', phoneNumber: 'owner', role: 'organizer' } })).id;
    buyer = (await db.user.create({ data: { name: 'Buyer', phoneNumber: 'buyer' } })).id;
    eventId = (await db.event.create({ data: { organizerId: owner, title: 'Test', description: 'Test', locationAddress: 'Test', locationCity: 'Test', locationCountry: 'SZ', category: 'music', startDate: new Date(), endDate: new Date('2099-01-01'), isPublished: true } })).id;
    tierId = (await db.ticketType.create({ data: { eventId, name: 'General', price: 100, quantity: 5, saleStartDate: new Date(0), saleEndDate: new Date('2099-01-01') } })).id;
    (createCharge as jest.Mock).mockResolvedValue({ id: 'test-charge', status: 'FAILED' });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { await db.$disconnect(); });
  const snapshot = async () => Promise.all([db.event.findMany(), db.ticketType.findMany(), db.ticket.findMany(), db.ticketPurchaseAttempt.findMany(), db.ticketRefundLock.findMany(), db.ticketAdmissionReceipt.findMany(), db.ticketOrderDelivery.findMany()]);
  it.each([0, 5])('deletes an event with %i never-purchased tickets', async count => {
    if (count) await generateTickets(tierId, count, owner);
    await deleteEvent(eventId, owner);
    expect(await db.event.count()).toBe(0); expect(await db.ticketType.count()).toBe(0); expect(await db.ticket.count()).toBe(0);
  });
  it('rejects a nonowner without changing records', async () => {
    await generateTickets(tierId, 2, owner); const before = await snapshot();
    await expect(deleteEvent(eventId, buyer)).rejects.toMatchObject({ statusCode: 404 });
    expect(await snapshot()).toEqual(before);
  });
  it('retains failed purchase -> released inventory -> tier delete -> event delete history', async () => {
    await generateTickets(tierId, 1, owner);
    await expect(purchaseTicket(tierId, buyer, payment)).rejects.toMatchObject({ statusCode: 402 });
    expect(await db.ticket.findFirst()).toMatchObject({ status: 'available', paymentRef: null, userId: null });
    const before = await snapshot();
    await expect(deleteTicketType(tierId, owner)).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteEvent(eventId, owner)).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    { status: 'sold' }, { status: 'reserved' }, { status: 'cancelled' },
    { paymentRef: 'charge' }, { paymentStatus: 'FAILED' }, { amountPaid: 0 },
    { purchaseDate: new Date() }, { isCheckedIn: true }, { checkedInAt: new Date() },
    { refundRef: 'refund' }, { refundedAt: new Date() }, { cancelledAt: new Date() },
    { refundRequestedAt: new Date() }, { refundRequestReason: 'reason' }, { reservedAt: new Date() },
  ])('retains all records for ticket history %j', async data => {
    await generateTickets(tierId, 1, owner);
    await db.ticket.updateMany({ data: data as any }); const before = await snapshot();
    await expect(deleteEvent(eventId, owner)).rejects.toMatchObject({ statusCode: 409 });
    await expect(deleteTicketType(tierId, owner)).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['admission', 'refund', 'delivery'])('retains independent %s history', async kind => {
    await generateTickets(tierId, 1, owner); const ticket = (await db.ticket.findFirst())!;
    if (kind === 'admission') await db.ticketAdmissionReceipt.create({ data: { opId: 'op', operatorId: owner, eventId, ticketId: 'retained-independent-id', response: {} } });
    if (kind === 'refund') await db.ticketRefundLock.create({ data: { chargeId: 'charge', ticketId: ticket.id, amount: 100 } });
    if (kind === 'delivery') { await db.ticketOrderDelivery.create({ data: { id: 'order' } }); await db.ticket.update({ where: { id: ticket.id }, data: { deliveryOrderId: 'order' } }); }
    const before = await snapshot(); await expect(deleteEvent(eventId, owner)).rejects.toMatchObject({ statusCode: 409 }); expect(await snapshot()).toEqual(before);
  });
  it.each(['checkout', 'generation', 'update', 'tier deletion', 'tier creation'].flatMap(operation => [true, false].map(deleteFirst => ({ operation, deleteFirst }))))('serializes $operation (delete first: $deleteFirst)', async ({ operation, deleteFirst }) => {
    await generateTickets(tierId, 1, owner);
    const locked = deferred(), release = deferred(); let intercepted = false;
    const transaction = db.$transaction.bind(db);
    jest.spyOn(db, '$transaction').mockImplementation(((callback: any) => transaction(async tx => callback(new Proxy(tx, { get(target, prop) {
      if (prop !== '$queryRaw') return (target as any)[prop];
      return async (...args: any[]) => {
        const sql = args[0].join ? args[0].join('?') : args[0].sql;
        const result = await (target.$queryRaw as any)(...args);
        if (!intercepted && sql.includes('FROM "Event"') && sql.includes('FOR ')) {
          intercepted = true; locked.resolve(); await release.promise;
        }
        return result;
      };
    } })), { timeout: 15000 })) as any);
    const remove = () => deleteEvent(eventId, owner);
    const mutate = () => operation === 'checkout' ? purchaseTicket(tierId, buyer, payment)
      : operation === 'generation' ? generateTickets(tierId, 2, owner)
      : operation === 'update' ? updateTicketType(tierId, { quantity: 4 }, owner)
      : operation === 'tier deletion' ? deleteTicketType(tierId, owner)
      : createTicketType({ name: 'New', price: 10, quantity: 1, saleStartDate: new Date(0), saleEndDate: new Date('2099-01-01') } as any, eventId, owner);
    const first = (deleteFirst ? remove : mutate)();
    await locked.promise;
    const second = (deleteFirst ? mutate : remove)();
    // Observe a real blocked backend before releasing the first transaction.
    try {
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const rows = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`;
        blocked = rows[0].blocked;
        if (!blocked) await new Promise(r => setTimeout(r, 5));
      }
      expect(blocked).toBe(true);
    } finally { release.resolve(); }
    const results = await Promise.allSettled([first, second]);
    for (const result of results) if (result.status === 'rejected') expect([402, 404, 409]).toContain(result.reason.statusCode);
    if (operation === 'checkout' && !deleteFirst) {
      expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } });
      expect(await db.event.count()).toBe(1); expect(await db.ticket.count()).toBe(1);
    } else {
      expect(await db.event.count()).toBe(0); expect(await db.ticketType.count()).toBe(0); expect(await db.ticket.count()).toBe(0);
    }
  });
});
