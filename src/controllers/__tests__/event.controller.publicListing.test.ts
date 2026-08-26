import { Request, Response } from 'express';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

// Unlike event.controller.test.ts (which mocks event.service to assert *which*
// params the controller forwards), this suite exercises the real controller
// against the real service with only prisma mocked. That proves the end state
// the security fix actually promises — the Prisma `where` clause an anonymous
// GET /api/events produces — so the regression is still caught if either the
// controller's stripping OR the service's isPublished/isCancelled defaults
// regress. Asserting only the forwarded query would miss the latter.
jest.mock('../../config/prisma', () => ({
  __esModule: true,
  default: mockDeep<PrismaClient>(),
}));

import prisma from '../../config/prisma';
import { getEventsController } from '../event.controller';

const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

const buildRes = () => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
};

beforeEach(() => {
  mockReset(prismaMock);
  // getEvents runs findMany + count together via prisma.$transaction([...]);
  // the array form just needs its member promises awaited, same as real Prisma.
  prismaMock.$transaction.mockImplementation(((ops: any[]) => Promise.all(ops)) as any);
  prismaMock.event.findMany.mockResolvedValue([] as any);
  prismaMock.event.count.mockResolvedValue(0);
});

const whereFromLastQuery = () =>
  (prismaMock.event.findMany.mock.calls[0][0] as any).where;

describe('GET /api/events (anonymous) — always scoped to published, non-cancelled events', () => {
  it('forces isPublished:true and isCancelled:false for ?showUnpublished=true&organizer=<id>', async () => {
    // The exact reported attack: enumerate one organizer's drafts unauthenticated.
    const req = {
      query: { showUnpublished: 'true', organizer: 'victim-organizer-id' },
    } as unknown as Request;
    const next = jest.fn();

    await getEventsController(req, buildRes(), next);

    expect(next).not.toHaveBeenCalled();
    const where = whereFromLastQuery();
    expect(where.isPublished).toBe(true);
    expect(where.isCancelled).toBe(false);
    // The organizer filter itself stays honoured — scoping the public listing to
    // one organizer is a legitimate feature once drafts are already excluded.
    expect(where.organizerId).toBe('victim-organizer-id');
  });

  it('forces isCancelled:false for ?showCancelled=true', async () => {
    const req = { query: { showCancelled: 'true' } } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    const where = whereFromLastQuery();
    expect(where.isCancelled).toBe(false);
    expect(where.isPublished).toBe(true);
  });

  it('forces both filters when every leak param is combined at once', async () => {
    const req = {
      query: {
        showUnpublished: 'true',
        showCancelled: 'true',
        organizer: 'victim-organizer-id',
        includePast: 'true',
      },
    } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    const where = whereFromLastQuery();
    expect(where.isPublished).toBe(true);
    expect(where.isCancelled).toBe(false);
  });
});

describe('GET /api/organizers/events (authenticated) — organizer still sees its own drafts', () => {
  it('does NOT force isPublished/isCancelled when protect has set req.user', async () => {
    // Mirrors organizer.routes.ts's wrapper middleware, which sets these
    // server-side after protect + authorize(ORGANIZER, ADMIN).
    const req = {
      query: {
        organizer: 'org-1',
        showUnpublished: 'true',
        showCancelled: 'true',
        includePast: 'true',
      },
      user: { id: 'org-1', role: 'ORGANIZER' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    const where = whereFromLastQuery();
    expect(where.isPublished).toBeUndefined();
    expect(where.isCancelled).toBeUndefined();
    expect(where.organizerId).toBe('org-1');
  });
});
