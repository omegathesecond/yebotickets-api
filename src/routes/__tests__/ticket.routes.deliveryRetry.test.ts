jest.mock('../../services/ticket.service', () => ({
  ...jest.requireActual('../../services/ticket.service'), retryTicketOrderDelivery: jest.fn(),
}));
jest.mock('../../middleware/auth.middleware', () => ({
  ...jest.requireActual('../../middleware/auth.middleware'),
  protect: (req: any, _res: any, next: any) => {
    if (req.headers['x-test-user']) req.user = { id: req.headers['x-test-user'] };
    next();
  },
}));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import routes from '../ticket.routes';
import { retryTicketOrderDelivery } from '../../services/ticket.service';
import { errorHandler } from '../../middleware/error.middleware';
const retry = retryTicketOrderDelivery as jest.Mock;
let server: http.Server, url: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/tickets', routes); app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tickets/ticket-id/delivery/retry`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { retry.mockReset(); retry.mockResolvedValue({ status: 'sent' }); });
const post = (user?: string, body = {}) => fetch(url, { method: 'POST', headers: {
  'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}),
}, body: JSON.stringify(body) });
test('requires authentication and rejects malformed ambiguity acknowledgement', async () => {
  expect((await post()).status).toBe(401);
  expect((await post('invalid', { acknowledgeDuplicateRisk: 'true' })).status).toBe(400);
  expect(retry).not.toHaveBeenCalled();
});
test('uses authenticated buyer identity and preserves true acknowledgement', async () => {
  expect((await post('buyer', { acknowledgeDuplicateRisk: true })).status).toBe(200);
  expect(retry).toHaveBeenCalledWith('ticket-id', 'buyer', true);
});
test('throttles repeated retries by account', async () => {
  for (let n = 0; n < 5; n++) expect((await post('rate-user')).status).toBe(200);
  expect((await post('rate-user')).status).toBe(429);
  expect(retry).toHaveBeenCalledTimes(5);
});
