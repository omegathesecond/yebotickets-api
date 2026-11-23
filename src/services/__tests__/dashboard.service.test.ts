import {mockDeep,mockReset,DeepMockProxy} from 'jest-mock-extended';
import type {PrismaClient} from '@prisma/client';
jest.mock('../../config/prisma',()=>({__esModule:true,default:mockDeep<PrismaClient>()}));
import prisma from '../../config/prisma';
import {getDashboardMetrics} from '../dashboard.service';
const db=prisma as unknown as DeepMockProxy<PrismaClient>;
beforeEach(()=>{
 mockReset(db);db.event.count.mockResolvedValue(1);db.ticket.count.mockResolvedValue(2);db.user.count.mockResolvedValue(1);
});
it('reports original paid allocations in the platform currency and excludes cancelled active events',async()=>{
 db.ticket.findMany.mockResolvedValueOnce([{amountPaid:60,ticketType:{price:999}},{amountPaid:0}] as any).mockResolvedValueOnce([{amountPaid:30}] as any);
 expect((await getDashboardMetrics()).revenue).toMatchObject({value:60,currency:'SZL',changePercent:100});
 expect(db.event.count.mock.calls[0][0]?.where).toMatchObject({isCancelled:false});
});
it('surfaces missing payment evidence rather than substituting tier price or zero',async()=>{
 db.ticket.findMany.mockResolvedValueOnce([{amountPaid:null,ticketType:{price:100}}] as any).mockResolvedValueOnce([]);
 await expect(getDashboardMetrics()).rejects.toThrow(/Recorded ticket payment amount is missing/);
});
it('reports zero only when the actual payment query has no sold records',async()=>{
 db.ticket.findMany.mockResolvedValue([]);
 expect((await getDashboardMetrics()).revenue).toMatchObject({value:0,currency:'SZL'});
});
