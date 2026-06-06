import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Replace the prisma singleton (default export of ../config/prisma) with a deep
// jest mock so getEvents' query is inspected without touching a database.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getEvents, getEventById } from '../event.service';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => {
  mockReset(prismaMock);
});

const buildEventRow = (over: Partial<any> = {}) => ({
  id: 'event-1',
  title: 'Test Fest',
  description: 'A test event',
  locationAddress: '1 Main St',
  locationCity: 'Mbabane',
  locationCountry: 'Eswatini',
  locationLat: null,
  locationLng: null,
  startDate: new Date('2026-07-01T18:00:00Z'),
  endDate: new Date('2026-07-01T23:00:00Z'),
  organizerId: 'org-1',
  organizer: { id: 'org-1', name: 'Org', email: 'org@example.com' },
  isPublished: true,
  isCancelled: false,
  cancelledAt: null,
  coverImage: null,
  category: 'music',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('getEvents — cancelled events excluded from listings', () => {
  it('excludes cancelled events by default (where.isCancelled === false)', async () => {
    prismaMock.event.findMany.mockResolvedValue([buildEventRow()] as any);

    await getEvents({});

    const arg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(arg.where.isCancelled).toBe(false);
    // Default also still scopes to published events.
    expect(arg.where.isPublished).toBe(true);
  });

  it('includes cancelled events only when showCancelled=true is passed', async () => {
    prismaMock.event.findMany.mockResolvedValue([] as any);

    await getEvents({ showCancelled: 'true' });

    const arg = prismaMock.event.findMany.mock.calls[0][0] as any;
    expect(arg.where.isCancelled).toBeUndefined();
  });
});

describe('transformEvent — surfaces cancellation state', () => {
  it('exposes isCancelled/cancelledAt so a client can show a dead event', async () => {
    const cancelledAt = new Date('2026-06-06T13:00:00Z');
    prismaMock.event.findUnique.mockResolvedValue(
      buildEventRow({ isCancelled: true, cancelledAt, ticketTypes: [] }) as any
    );

    const event = await getEventById('event-1');

    expect(event.isCancelled).toBe(true);
    expect(event.cancelledAt).toEqual(cancelledAt);
  });

  it('defaults isCancelled to false for a live event', async () => {
    prismaMock.event.findMany.mockResolvedValue([buildEventRow()] as any);

    const [event] = await getEvents({});

    expect(event.isCancelled).toBe(false);
    expect(event.cancelledAt).toBeNull();
  });
});
