import type { Request, Response } from 'express';
jest.mock('../../services/organizer-event.service', () => ({ getEventTickets: jest.fn() }));
import { getEventTickets } from '../../services/organizer-event.service';
import { getEventTicketsController } from '../organizer-event.controller';

it('forwards the pending filter and pagination with the authenticated organiser', async () => {
  const result = { tickets: [], totalTickets: 0, currentPage: 1, totalPages: 1 };
  jest.mocked(getEventTickets).mockResolvedValue(result);
  const req = { params: { id: 'event' }, query: { page: '2', limit: '5', pendingRefunds: 'true' }, user: { id: 'owner', role: 'organizer' } } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  const next = jest.fn();
  await getEventTicketsController(req, res, next);
  expect(getEventTickets).toHaveBeenCalledWith('event', { id: 'owner', role: 'organizer' }, '2', '5', 'true');
  expect(res.json).toHaveBeenCalledWith(result);
  expect(next).not.toHaveBeenCalled();
});
