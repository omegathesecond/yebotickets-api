import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import organizerRoutes from '../organizer.routes';
import eventRoutes from '../event.routes';
import { protect } from '../../middleware/auth.middleware';
import { getEventsController } from '../../controllers/event.controller';
import { errorHandler } from '../../middleware/error.middleware';
import prisma from '../../config/prisma';
const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const secret = 'listing-visibility-test';
const oldSecret = process.env.JWT_SECRET;
let server: http.Server;
let baseUrl: string;
const events = ['A', 'B'].flatMap(organizerId => [
  { id: organizerId + '-public', organizerId, isPublished: true, isCancelled: false },
  { id: organizerId + '-draft', organizerId, isPublished: false, isCancelled: false },
  { id: organizerId + '-cancelled', organizerId, isPublished: true, isCancelled: true },
]).map(event => ({ ...event, ticketTypes: [], startDate: new Date('2099-01-01'), endDate: new Date('2099-01-02') }));
const matches = (event: any, where: any) =>
  (!where.organizerId || event.organizerId === where.organizerId) &&
  (where.isPublished === undefined || event.isPublished === where.isPublished) &&
  (where.isCancelled === undefined || event.isCancelled === where.isCancelled);
beforeAll(async () => {
  process.env.JWT_SECRET = secret;
  const app = express();
  app.use('/organizers', organizerRoutes);
  app.use('/events', eventRoutes);
  // Also exercise the shared controller when authenticated customers/organisers
  // are present, since the public route itself deliberately has no auth.
  app.get('/authenticated-events', protect, getEventsController);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  mockReset(db);
  db.$transaction.mockImplementation(((ops: any[]) => Promise.all(ops)) as any);
  db.event.findMany.mockImplementation((async (args: any) => events.filter(event => matches(event, args.where))) as any);
  db.event.count.mockImplementation((async (args: any) => events.filter(event => matches(event, args.where)).length) as any);
});
async function read(path: string, role?: string) {
  const headers: Record<string, string> = {};
  if (role) {
    db.user.findUnique.mockResolvedValue({ id: 'A', role, isPhoneVerified: true, isSuspended: false } as any);
    headers.authorization = 'Bearer ' + jwt.sign({ id: 'A' }, secret);
  }
  const response = await fetch(baseUrl + path, { headers });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(body.data.length);
  expect(db.event.count.mock.calls[0][0]?.where).toEqual(db.event.findMany.mock.calls[0][0]?.where);
  return body.data.map((event: any) => event.id);
}
it.each(['', '&organizer=B'])('forces owner scope for organiser route %s', async filter => {
  expect(await read('/organizers/events?showCancelled=true' + filter, 'organizer'))
    .toEqual(['A-public', 'A-draft', 'A-cancelled']);
});
it.each(['', '&organizer=B'])('scopes private queries at the shared controller/service boundary %s', async filter => {
  expect(await read('/authenticated-events?showUnpublished=true&showCancelled=true' + filter, 'organizer'))
    .toEqual(['A-public', 'A-draft', 'A-cancelled']);
});
it('allows admins to enumerate private events across organisers', async () => {
  expect(await read('/organizers/events?showCancelled=true', 'admin')).toEqual(events.map(event => event.id));
});
it('allows admins to filter another organiser including private events', async () => {
  expect(await read('/organizers/events?showCancelled=true&organizer=B', 'admin'))
    .toEqual(['B-public', 'B-draft', 'B-cancelled']);
});
it('keeps anonymous browsing published and uncancelled despite private flags', async () => {
  expect(await read('/events?showUnpublished=true&showCancelled=true')).toEqual(['A-public', 'B-public']);
});
it('keeps authenticated customer browsing public', async () => {
  expect(await read('/authenticated-events?showUnpublished=true&showCancelled=true', 'user'))
    .toEqual(['A-public', 'B-public']);
});
it('allows public browsing of another organiser by an organiser', async () => {
  expect(await read('/authenticated-events?organizer=B', 'organizer')).toEqual(['B-public']);
});
