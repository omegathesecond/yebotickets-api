import express from 'express';
import http from 'http';
import { Duplex } from 'stream';
import { createTicketTypeValidator, updateTicketTypeValidator } from '../ticket.validator';
import { validate } from '../../middleware/validate.middleware';
import { errorHandler } from '../../middleware/error.middleware';
import { amountToCents, orderAmount } from '../../utils/money';

const app = express();
app.use(express.json());
app.post('/types', validate(createTicketTypeValidator), (_req, res) => { res.sendStatus(201); });
app.put('/types/tier', validate(updateTicketTypeValidator), (_req, res) => { res.sendStatus(200); });
app.use(errorHandler);

// Exercise the HTTP request/response pipeline without binding a TCP listener.
const request = (method: string, price: unknown): Promise<number> => new Promise((resolve, reject) => {
  const body = JSON.stringify({ name: 'General', price, quantity: 1, saleStartDate: '2026-01-01T00:00:00Z', saleEndDate: '2099-01-01T00:00:00Z' });
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const req = new http.IncomingMessage(socket as import('net').Socket);
  // The whole request is supplied below; keep stream EOF from aborting the response.
  req.complete = true;
  req.method = method;
  req.url = method === 'POST' ? '/types' : '/types/tier';
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  const res = new http.ServerResponse(req);
  res.assignSocket(socket as import('net').Socket);
  req.on('error', reject);
  res.on('error', reject);
  res.on('finish', () => { resolve(res.statusCode); socket.destroy(); });
  app(req, res);
  req.push(body);
  req.push(null);
});
it.each([10.001, -1, NaN, Infinity, -Infinity, null, 'NaN', 'Infinity', '10.001', 0.001, 1e100, true])('HTTP create/update reject invalid price %p', async price => {
  for (const method of ['POST', 'PUT']) {
    const status = await request(method, price);
    expect(status).toBe(400);
  }
});
it.each([0, 0.01, 10.10, 0.29])('HTTP create/update accept cent price %p', async price => {
  for (const method of ['POST', 'PUT']) {
    const status = await request(method, price);
    expect(status).toBe(method === 'POST' ? 201 : 200);
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
