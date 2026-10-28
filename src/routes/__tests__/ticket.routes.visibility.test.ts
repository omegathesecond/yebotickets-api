import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import ticketRoutes from '../ticket.routes';
import { errorHandler } from '../../middleware/error.middleware';
import prisma from '../../config/prisma';
import { generateAccessToken } from '../../services/token.service';
const db = prisma as unknown as DeepMockProxy<PrismaClient>;
let server: http.Server;
let baseUrl: string;
const secret = 'visibility-test-secret';
const oldSecret = process.env.JWT_SECRET;
beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use('/tickets', ticketRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  mockReset(db);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  db.event.findUnique.mockResolvedValue({ organizerId: 'owner', isPublished: false, isCancelled: false } as any);
  db.ticketType.findMany.mockResolvedValue([{ id: 'tier', name: 'General', price: 100, type: 'regular' }] as any);
  (db.ticket.groupBy as jest.Mock).mockResolvedValue([{ ticketTypeId: 'tier', _count: { _all: 3 } }]);
});
afterEach(() => jest.restoreAllMocks());
const read = (authorization?: string, query = '') => fetch(baseUrl + '/tickets/types/event/event-1' + query, {
  headers: authorization === undefined ? {} : { authorization },
});
const authenticate = (id: string, role: string) => {
  const sessionVersion = 2;
  db.user.findUnique.mockResolvedValue({ id, role, sessionVersion } as any);
  // Even a signed role claim cannot override the database role.
  return `Bearer ${generateAccessToken(id, 'admin', sessionVersion)}`;
};
it('returns published inventory anonymously', async () => {
  db.event.findUnique.mockResolvedValue({ organizerId: 'owner', isPublished: true, isCancelled: false } as any);
  const response = await read();
  expect(response.status).toBe(200);
  expect((await response.json()).data[0]).toMatchObject({ name: 'General', price: 100, availableQuantity: 3 });
});
it.each(['draft', 'cancelled', 'missing'])('hides %s events and never reads inventory', async state => {
  if (state === 'cancelled') db.event.findUnique.mockResolvedValue({ organizerId: 'owner', isPublished: true, isCancelled: true } as any);
  if (state === 'missing') db.event.findUnique.mockResolvedValue(null);
  const response = await read(undefined, '?role=admin&organizerId=owner');
  expect(response.status).toBe(404);
  expect((await response.json()).error).toBe('Event not found');
  expect(db.ticketType.findMany).not.toHaveBeenCalled();
});
it.each(['user', 'organizer'])('rejects an unrelated authenticated %s', async role => {
  expect((await read(authenticate('other', role))).status).toBe(404);
  expect(db.ticketType.findMany).not.toHaveBeenCalled();
});
it.each([['owner', 'organizer'], ['admin-id', 'admin']])('allows %s draft tier loading for editing/detail', async (id, role) => {
  const response = await read(authenticate(id, role));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toHaveLength(1);
});
it.each([['owner', 'organizer'], ['admin-id', 'admin']])('allows %s to manage cancelled event tiers', async (id, role) => {
  db.event.findUnique.mockResolvedValue({ organizerId: 'owner', isPublished: true, isCancelled: true } as any);
  expect((await read(authenticate(id, role))).status).toBe(200);
});
it.each(['Basic abc', 'Bearer', 'Bearer invalid', 'Bearer a b', ''])('rejects malformed credentials %p even for a published event', async header => {
  db.event.findUnique.mockResolvedValue({ organizerId: 'owner', isPublished: true, isCancelled: false } as any);
  expect((await read(header)).status).toBe(401);
  expect(db.event.findUnique).not.toHaveBeenCalled();
});
it('rejects expired and incorrectly signed tokens', async () => {
  for (const token of [jwt.sign({ id: 'owner' }, secret, { expiresIn: -1 }), jwt.sign({ id: 'owner' }, 'wrong')]) {
    expect((await read(`Bearer ${token}`)).status).toBe(401);
  }
  expect(db.ticketType.findMany).not.toHaveBeenCalled();
});
it('rejects unversioned tokens even for an existing organiser', async () => {
  authenticate('owner', 'organizer');
  expect((await read(`Bearer ${jwt.sign({ id: 'owner', role: 'organizer' }, secret)}`)).status).toBe(401);
  expect(db.event.findUnique).not.toHaveBeenCalled();
  expect(db.ticketType.findMany).not.toHaveBeenCalled();
});
