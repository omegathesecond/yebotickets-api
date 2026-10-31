import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createTicketTypeValidator, updateTicketTypeValidator } from '../ticket.validator';
import { validate } from '../../middleware/validate.middleware';
import { errorHandler } from '../../middleware/error.middleware';
import { amountToCents, orderAmount } from '../../utils/money';

let server: http.Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/types', validate(createTicketTypeValidator), (_req, res) => { res.sendStatus(201); });
  app.put('/types/tier', validate(updateTicketTypeValidator), (_req, res) => { res.sendStatus(200); });
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it.each([10.001, -1, null, 'NaN', 'Infinity', '10.001', 0.001, 1e100, true])('HTTP create/update reject invalid price %p', async price => {
  for (const method of ['POST', 'PUT']) {
    const response = await fetch(base + (method === 'POST' ? '/types' : '/types/tier'), {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'General', price, quantity: 1, saleStartDate: '2026-01-01T00:00:00Z', saleEndDate: '2099-01-01T00:00:00Z' }),
    });
    expect(response.status).toBe(400);
  }
});
it.each([0, 0.01, 10.10, 0.29])('HTTP create/update accept cent price %p', async price => {
  for (const method of ['POST', 'PUT']) {
    const response = await fetch(base + (method === 'POST' ? '/types' : '/types/tier'), {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'General', price, quantity: 1, saleStartDate: '2026-01-01T00:00:00Z', saleEndDate: '2099-01-01T00:00:00Z' }),
    });
    expect(response.status).toBe(method === 'POST' ? 201 : 200);
  }
});
it.each([NaN, Infinity, -Infinity, 10.001, '10.10', undefined])('helper rejects %p without rounding/coercing', value => {
  expect(() => amountToCents(value)).toThrow();
});
it('computes cent totals and rejects unsafe totals', () => {
  expect(orderAmount(0.29, 3)).toBe(0.87);
  expect(orderAmount(10.10, 3)).toBe(30.3);
  expect(() => orderAmount(90071992547409.9, 10)).toThrow();
});
