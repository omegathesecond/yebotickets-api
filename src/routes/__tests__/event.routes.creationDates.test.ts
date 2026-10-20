import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
jest.mock('../../config/prisma', () => ({ __esModule: true, default: mockDeep<PrismaClient>() }));
jest.mock('../../middleware/auth.middleware', () => ({
  ...jest.requireActual('../../middleware/auth.middleware'),
  protect: (req: any, _res: any, next: any) => {
    req.user = { id: 'owner', role: 'organizer' };
    next();
  },
}));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import eventRoutes from '../event.routes';
import organizerRoutes from '../organizer.routes';
import { errorHandler } from '../../middleware/error.middleware';
import prisma from '../../config/prisma';
const db = prisma as unknown as DeepMockProxy<PrismaClient>;
let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/events', eventRoutes);
  app.use('/organizers', organizerRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
beforeEach(() => {
  mockReset(db);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
const payload = {
  title: 'Test festival', description: 'A festival', category: 'music',
  location: { address: '1 Main Street', city: 'Mbabane', country: 'Eswatini' },
  startDate: '2030-01-10T00:00:00.000Z', endDate: '2030-01-20T00:00:00.000Z',
};
for (const route of ['/events', '/organizers/events']) {
  describe(`POST ${route}`, () => {
    it.each([
      { endDate: payload.startDate },
      { endDate: '2030-01-01T00:00:00.000Z' },
      { startDate: 'bad date' },
      { startDate: undefined },
      { title: undefined },
    ])('rejects invalid creation without writing: %p', async patch => {
      const response = await fetch(baseUrl + route, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, ...patch }),
      });
      expect(response.status).toBe(400);
      expect(db.event.create).not.toHaveBeenCalled();
    });
    it('creates a valid event', async () => {
      db.event.create.mockResolvedValue({ ...payload, id: 'event', organizerId: 'owner' } as any);
      const response = await fetch(baseUrl + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(201);
      expect(db.event.create).toHaveBeenCalledTimes(1);
    });
  });
}
