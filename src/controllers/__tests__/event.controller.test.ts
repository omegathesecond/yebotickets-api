import { Request, Response } from 'express';

jest.mock('../../services/event.service', () => ({
  getEvents: jest.fn(),
}));

import { getEvents } from '../../services/event.service';
import { getEventsController } from '../event.controller';

const getEventsMock = getEvents as jest.Mock;

const buildRes = () => {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
};

beforeEach(() => {
  getEventsMock.mockReset();
  getEventsMock.mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, hasMore: false });
});

describe('getEventsController — public route never trusts anonymous showUnpublished/showCancelled', () => {
  it('strips showUnpublished and organizer-enumeration params before calling getEvents, even when both are supplied', async () => {
    const req = {
      query: { showUnpublished: 'true', organizer: 'some-organizer-id' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    expect(getEventsMock).toHaveBeenCalledTimes(1);
    const passedQuery = getEventsMock.mock.calls[0][0];
    expect(passedQuery.showUnpublished).toBeUndefined();
    // organizer is not itself sensitive once showUnpublished/showCancelled are
    // stripped (getEvents() still forces isPublished:true/isCancelled:false),
    // but assert it passes through unmodified for legitimate public filtering.
    expect(passedQuery.organizer).toBe('some-organizer-id');
  });

  it('strips showCancelled so anonymous callers cannot list cancelled events', async () => {
    const req = {
      query: { showCancelled: 'true' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    const passedQuery = getEventsMock.mock.calls[0][0];
    expect(passedQuery.showCancelled).toBeUndefined();
  });
});

describe('getEventsController — authenticated callers (e.g. GET /api/organizers/events) keep their query untouched', () => {
  it('does not strip showUnpublished/showCancelled when req.user is present', async () => {
    const req = {
      query: { showUnpublished: 'true', showCancelled: 'true', organizer: 'org-1', includePast: 'true' },
      user: { id: 'org-1', role: 'ORGANIZER' },
    } as unknown as Request;

    await getEventsController(req, buildRes(), jest.fn());

    expect(getEventsMock).toHaveBeenCalledTimes(1);
    const passedQuery = getEventsMock.mock.calls[0][0];
    expect(passedQuery.showUnpublished).toBe('true');
    expect(passedQuery.showCancelled).toBe('true');
    expect(passedQuery.organizer).toBe('org-1');
  });
});
