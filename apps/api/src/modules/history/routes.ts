import { Router } from 'express';
import { historyQuerySchema, type HistoryType } from '@kass/shared';
import type { z } from 'zod';
import { auth, h, ok, shopId } from '../../lib/http';
import { oid } from '../../lib/util';
import { assertBranchAccess, authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { historyFeed } from './feed';

/** Shop panel: everything that happened at the tills and in the warehouse, newest first. */
export const historyRouter = Router();
historyRouter.use(authenticate);

historyRouter.get(
  '/',
  requirePermission('reports.view'),
  validate({ query: historyQuerySchema }),
  h(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof historyQuerySchema>;
    const a = auth(req);
    let branchIds = a.role === 'shop_admin' ? undefined : a.branchIds.map((b) => oid(String(b)));
    if (q.branchId) {
      assertBranchAccess(req, q.branchId);
      branchIds = [oid(q.branchId)];
    }
    const r = await historyFeed({ shopId: oid(String(shopId(req))), type: q.type as HistoryType | undefined, from: q.from, to: q.to, branchIds, terminalId: q.terminalId, q: q.q, page: q.page, limit: q.limit });
    ok(res, r.items, { page: q.page, limit: q.limit, total: r.total, summary: r.summary });
  }),
);
