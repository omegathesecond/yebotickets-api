import { mockDeep } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import prisma from '../../config/prisma';
import organizerRoutes from '../organizer.routes';
import ticketRoutes from '../ticket.routes';
import eventRoutes from '../event.routes';
import { errorHandler } from '../../middleware/error.middleware';
import { generateAuthTokens } from '../../services/token.service';
const db = prisma as ReturnType<typeof mockDeep<PrismaClient>>;
let server: http.Server;
let url: string;
let token: string;
beforeAll(async () => {
  process.env.JWT_SECRET = 'route-suspension-test';
  token = generateAuthTokens('org', 'organizer').token;
  const app = express();
  app.use(express.json());
  app.use('/organizers', organizerRoutes);
  app.use('/tickets', ticketRoutes);
  app.use('/events', eventRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
it.each([
  ['/organizers/events', 'POST'], ['/events/event-1', 'PUT'],
  ['/tickets/confirm-check-in', 'POST'], ['/tickets/check-in-details', 'POST'],
  ['/organizers/payout-requests', 'POST'],
])('blocks suspended bearer at %s before privileged processing', async (path, method) => {
  db.user.findUnique.mockResolvedValue({ id: 'org', role: 'organizer', isVerified: true, isSuspended: true } as any);
  const response = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: 'Organizer account is suspended' });
  expect(db.event.update).not.toHaveBeenCalled();
  expect(db.ticket.update).not.toHaveBeenCalled();
  expect(db.payoutRequest.create).not.toHaveBeenCalled();
});
