import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

// cancelEvent's refund path pulls these in transitively via ticket.service;
// stubbed the same way ticket.service.test.ts does so a sold ticket in the
// cancel scenario never makes a real QR/comms/YeboPay call.
jest.mock('../../services/qr.service', () => ({
  buildTicketQrPayload: jest.fn(() => ({})),
  generateTicketQrDataUrl: jest.fn(async () => 'data:image/png;base64,FAKEQR'),
  generateTicketQrBuffer: jest.fn(async () => Buffer.from('fake-qr-png')),
}));

jest.mock('../../services/comms.service', () => ({
  sendTextMessage: jest.fn(async () => ({ ok: true })),
  sendEmailMessage: jest.fn(async () => ({ ok: true })),
}));

jest.mock('../../services/yebopay.service', () => ({
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

// Stub `protect` to attach req.user straight from a test-only header instead
// of verifying a real JWT, while reusing the REAL `authorize` implementation —
// this exercises the actual route wiring (authorize(ADMIN) on this route),
// not just moderateEventController in isolation.
jest.mock('../../middleware/auth.middleware', () => {
  const actual = jest.requireActual('../../middleware/auth.middleware');
  return {
    ...actual,
    protect: (req: any, _res: any, next: any) => {
      const role = req.headers['x-test-role'];
      if (role) {
        req.user = { id: 'admin-1', role, name: 'Test', phoneNumber: '+1', email: null, isVerified: true };
      }
      next();
    },
  };
});

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import eventRoutes from '../event.routes';
import prisma from '../../config/prisma';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/events', eventRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  mockReset(prismaMock);
});

const patchModeration = (id: string, body: unknown, role?: string) =>
  fetch(`${baseUrl}/events/${id}/moderation`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(role ? { 'x-test-role': role } : {}),
    },
    body: JSON.stringify(body),
  });

describe('PATCH /events/:id/moderation — admin-only event moderation', () => {
  it('lets an admin unpublish an event owned by a DIFFERENT organizer', async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      id: 'event-1',
      organizerId: 'someone-else',
    } as any);
    prismaMock.event.update.mockResolvedValue({
      id: 'event-1',
      title: 'Test Fest',
      organizerId: 'someone-else',
      isPublished: false,
      organizer: { id: 'someone-else', name: 'Org', email: 'org@example.com' },
    } as any);

    const res = await patchModeration('event-1', { action: 'unpublish' }, 'admin');

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.success).toBe(true);
    expect(payload.data.isPublished).toBe(false);
    expect(prismaMock.event.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.event.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'event-1' },
      data: { isPublished: false },
    });
  });

  it('lets an admin cancel an event owned by a DIFFERENT organizer', async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      id: 'event-1',
      organizerId: 'someone-else',
    } as any);
    prismaMock.event.update.mockResolvedValue({
      id: 'event-1',
      title: 'Test Fest',
      isCancelled: true,
    } as any);
    prismaMock.ticket.findMany.mockResolvedValue([] as any);

    const res = await patchModeration('event-1', { action: 'cancel' }, 'admin');

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.success).toBe(true);
    expect(payload.data).toMatchObject({ eventId: 'event-1', cancelled: true, totalProcessed: 0 });
    // assertEventAccess never rejects for an admin, regardless of ownership.
    expect(prismaMock.event.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.event.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'event-1' },
      data: { isCancelled: true },
    });
  });

  it('rejects a non-admin organizer with 403 — authorize(ADMIN) blocks before the controller runs', async () => {
    const res = await patchModeration('event-1', { action: 'unpublish' }, 'organizer');

    expect(res.status).toBe(403);
    expect(prismaMock.event.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.event.update).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 403', async () => {
    const res = await patchModeration('event-1', { action: 'unpublish' });

    expect(res.status).toBe(403);
    expect(prismaMock.event.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an invalid action value with 400 via moderateEventValidator, before the controller runs', async () => {
    const res = await patchModeration('event-1', { action: 'delete-forever' }, 'admin');

    expect(res.status).toBe(400);
    expect(prismaMock.event.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.event.update).not.toHaveBeenCalled();
  });

  it('rejects a missing action value with 400', async () => {
    const res = await patchModeration('event-1', {}, 'admin');

    expect(res.status).toBe(400);
    expect(prismaMock.event.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /events/admin/inventory', () => {
  const inventory = Array.from({ length: 105 }, (_, i) => ({
    id: `event-${i}`, title: `Event ${i}`, organizerId: `org-${i % 2}`,
    isPublished: i % 4 !== 1, isCancelled: i % 4 === 2,
    startDate: new Date(i % 4 === 3 ? '2020-01-01' : '2099-01-01'),
    endDate: new Date(i % 4 === 3 ? '2020-01-02' : '2099-01-02'),
    ticketTypes: [],
  }));

  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(((ops: any[]) => Promise.all(ops)) as any);
    prismaMock.event.findMany.mockImplementation((async ({ where, skip, take }: any) => {
      const matching = inventory.filter(e =>
        (where.isPublished === undefined || e.isPublished === where.isPublished) &&
        (where.isCancelled === undefined || e.isCancelled === where.isCancelled) &&
        (!where.endDate || e.endDate >= where.endDate.gte));
      return matching.slice(skip, skip + take);
    }) as any);
    prismaMock.event.count.mockResolvedValue(inventory.length);
  });

  it('enumerates lifecycle states and history across organizers over multiple pages', async () => {
    const ids: string[] = [];
    for (const page of [1, 2]) {
      const res = await fetch(`${baseUrl}/events/admin/inventory?page=${page}&limit=100&includePast=false&showCancelled=false&showUnpublished=false`, { headers: { 'x-test-role': 'admin' } });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({ total: 105, page, limit: 100, hasMore: page === 1 });
      ids.push(...body.data.map((e: any) => e.id));
    }
    expect(ids).toEqual(inventory.map(e => e.id));
    expect(prismaMock.event.findMany.mock.calls[0][0]).toMatchObject({ where: {}, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] });
  });

  it.each([undefined, 'customer', 'organizer'])('denies %s before reading events', async role => {
    const res = await fetch(`${baseUrl}/events/admin/inventory`, { headers: role ? { 'x-test-role': role } : {} });
    expect(res.status).toBe(403);
    expect(prismaMock.event.findMany).not.toHaveBeenCalled();
  });

  it('keeps public browsing restricted even with a supplied admin header and private flags', async () => {
    const res = await fetch(`${baseUrl}/events?showUnpublished=true&showCancelled=true`, { headers: { 'x-test-role': 'admin' } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.every((e: any) => e.isPublished && !e.isCancelled && new Date(e.endDate) > new Date())).toBe(true);
    expect(prismaMock.event.findMany.mock.calls[0][0]?.where).toMatchObject({ isPublished: true, isCancelled: false, endDate: { gte: expect.any(Date) } });
  });
});
