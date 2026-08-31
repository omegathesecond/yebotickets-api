import { Request, Response } from 'express';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Mirrors event.controller.publicListing.test.ts: exercises the real
// controller against the real service with only prisma mocked, so the fix
// is caught whether it regresses in the controller's viewer derivation or
// the service's isPublished/isCancelled/ownership gate.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getEventByIdController } from '../event.controller';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const buildRes = () => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
};

const baseEvent = {
  id: 'event-1',
  title: 'Draft Event',
  description: 'desc',
  locationAddress: '1 Main St',
  locationCity: 'Mbabane',
  locationCountry: 'Eswatini',
  locationLat: null,
  locationLng: null,
  startDate: new Date('2026-09-01'),
  endDate: new Date('2026-09-02'),
  organizerId: 'organizer-1',
  organizer: { id: 'organizer-1', name: 'Organizer', email: 'organizer@example.com' },
  isPublished: false,
  coverImage: null,
  category: 'music',
  isCancelled: false,
  cancelledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ticketTypes: [],
};

beforeEach(() => {
  mockReset(prismaMock);
});

const runController = async (req: Partial<Request>) => {
  const res = buildRes();
  const next = jest.fn();
  await getEventByIdController(req as Request, res, next);
  return { res, next };
};

describe('GET /api/events/:id — visibility gating', () => {
  it('404s an anonymous request for an unpublished event, with the same shape as "not found"', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ ...baseEvent, isPublished: false } as any);

    const { res, next } = await runController({ params: { id: 'event-1' }, query: {} } as any);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Event not found');
  });

  it('404s an anonymous request for a cancelled event', async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      ...baseEvent,
      isPublished: true,
      isCancelled: true,
    } as any);

    const { next } = await runController({ params: { id: 'event-1' }, query: {} } as any);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Event not found');
  });

  it('200s an anonymous request for a published, non-cancelled event but omits the organizer email', async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      ...baseEvent,
      isPublished: true,
      isCancelled: false,
    } as any);

    const { res, next } = await runController({ params: { id: 'event-1' }, query: {} } as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.organizer.email).toBeUndefined();
    expect(payload.data.organizer.name).toBe('Organizer');
  });

  it('200s the owning organizer fetching their own unpublished event, including their email', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ ...baseEvent, isPublished: false } as any);

    const { res, next } = await runController({
      params: { id: 'event-1' },
      query: {},
      user: { id: 'organizer-1', role: 'organizer' },
    } as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.organizer.email).toBe('organizer@example.com');
  });

  it('404s a different authenticated organizer fetching someone else\'s unpublished event', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ ...baseEvent, isPublished: false } as any);

    const { next } = await runController({
      params: { id: 'event-1' },
      query: {},
      user: { id: 'organizer-2', role: 'organizer' },
    } as any);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('200s an admin fetching any unpublished event, including the organizer email', async () => {
    prismaMock.event.findUnique.mockResolvedValue({ ...baseEvent, isPublished: false } as any);

    const { res, next } = await runController({
      params: { id: 'event-1' },
      query: {},
      user: { id: 'admin-1', role: 'admin' },
    } as any);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data.organizer.email).toBe('organizer@example.com');
  });
});
