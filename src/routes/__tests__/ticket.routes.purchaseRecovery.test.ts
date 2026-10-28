jest.mock('../../services/ticket.service', () => ({
  ...jest.requireActual('../../services/ticket.service'), recoverPurchaseAttempt: jest.fn(), purchaseTicket: jest.fn(),
}));
jest.mock('../../middleware/auth.middleware', () => ({
  ...jest.requireActual('../../middleware/auth.middleware'),
  protect: (req: any, _res: any, next: any) => {
    if (req.headers['x-test-user']) req.user = {id: req.headers['x-test-user']};
    next();
  },
}));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import routes from '../ticket.routes';
import { recoverPurchaseAttempt, purchaseTicket } from '../../services/ticket.service';
import { ApiError, errorHandler } from '../../middleware/error.middleware';
const recover = recoverPurchaseAttempt as jest.Mock;
const purchase = purchaseTicket as jest.Mock;
let server: http.Server, base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/tickets', routes); app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tickets`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => { recover.mockReset(); purchase.mockReset(); });
const post = (path: string, user?: string, body = {}) => fetch(base + path, {method: 'POST', headers: {
  'content-type': 'application/json', ...(user ? {'x-test-user': user} : {}),
}, body: JSON.stringify(body)});
const path = '/purchase-attempts/checkout-attempt-00001/recover';
test('recovery requires authentication', async () => {
  expect((await post(path)).status).toBe(401); expect(recover).not.toHaveBeenCalled();
});
test('pending/unknown is 202, recovery uses authenticated principal and never purchases', async () => {
  recover.mockResolvedValue({pending: true, unknown: true, tickets: []});
  const response = await post(path, 'buyer');
  expect(response.status).toBe(202);
  expect((await response.json()).data.unknown).toBe(true);
  expect(recover).toHaveBeenCalledWith('checkout-attempt-00001', 'buyer');
  expect(purchase).not.toHaveBeenCalled();
});
test('terminal failed recovery is explicit and authoritative', async () => {
  recover.mockResolvedValue({pending: false, failed: true, message: 'Payment failed', tickets: []});
  const response = await post(path, 'failed-buyer');
  expect(response.status).toBe(200); expect((await response.json()).data.failed).toBe(true);
});
test('gateway recovery errors propagate instead of returning fake success', async () => {
  recover.mockRejectedValue(new ApiError('Payment lookup failed', 502));
  const response = await post(path, 'error-buyer');
  expect(response.status).toBe(502); expect((await response.json()).error).toBe('Payment lookup failed');
});
test('a purchase without durable identity fails validation before dispatch', async () => {
  expect((await post('/purchase/550e8400-e29b-41d4-a716-446655440000', 'new-buyer', {})).status).toBe(400);
  expect(purchase).not.toHaveBeenCalled();
});
