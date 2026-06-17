import { Request, Response, NextFunction } from 'express';

// Mock the event service so the controller's query-sanitisation is inspected
// without touching a database.
jest.mock('../../services/event.service', () => ({
  __esModule: true,
  getEvents: jest.fn().mockResolvedValue([]),
}));

import { getEvents } from '../../services/event.service';
import { getEventsController } from '../event.controller';

const getEventsMock = getEvents as jest.MockedFunction<typeof getEvents>;

const buildRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const next: NextFunction = jest.fn();

beforeEach(() => {
  getEventsMock.mockClear();
});

describe('getEventsController — showUnpublished is admin-only', () => {
  it('strips showUnpublished from an anonymous (no user) request', async () => {
    const req = { query: { showUnpublished: 'true', category: 'music' } } as unknown as Request;

    await getEventsController(req, buildRes(), next);

    const passed = getEventsMock.mock.calls[0][0] as Record<string, any>;
    expect(passed.showUnpublished).toBeUndefined();
    expect(passed.category).toBe('music');
  });

  it('strips showUnpublished for a non-admin (e.g. organizer) request', async () => {
    const req = {
      query: { showUnpublished: 'true' },
      user: { id: 'u1', role: 'organizer' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), next);

    const passed = getEventsMock.mock.calls[0][0] as Record<string, any>;
    expect(passed.showUnpublished).toBeUndefined();
  });

  it('honours showUnpublished for an admin request', async () => {
    const req = {
      query: { showUnpublished: 'true' },
      user: { id: 'admin1', role: 'admin' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), next);

    const passed = getEventsMock.mock.calls[0][0] as Record<string, any>;
    expect(passed.showUnpublished).toBe('true');
  });
});
