import { Router } from 'express';
import { z } from 'zod';
import { objectId, paginationSchema } from '@kass/shared';
import { notFound } from '../../lib/errors';
import { fiscalProviderNames, runFiscal } from '../../lib/fiscal/service';
import { auth, h, ok, repo } from '../../lib/http';
import { oid } from '../../lib/util';
import { authenticate, canAccessBranch, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Terminal } from '../../models/core';
import { FiscalLog } from '../../models/sales';

export const fiscalRouter = Router();
fiscalRouter.use(authenticate);

/** Fiscal module status of a terminal; the POS checks it when opening a shift (spec 7.1). */
fiscalRouter.get(
  '/status/:terminalId',
  validate({ params: z.object({ terminalId: objectId }) }),
  requirePermission('shifts.operate', 'sales.create', 'terminals.manage', 'reports.view'),
  h(async (req, res) => {
    const a = auth(req);
    const terminal = await repo(req, Terminal).findById(req.params.terminalId);
    if (!terminal || !canAccessBranch(a, terminal.branchId)) throw notFound('TERMINAL_NOT_FOUND');
    if (!a.shop!.fiscalEnabled) return ok(res, { fiscalEnabled: false });
    if (!terminal.fiscal?.provider) return ok(res, { fiscalEnabled: true, configured: false, online: false });
    try {
      const status = await runFiscal({ terminal, shop: a.shop!, docType: 'status', fn: (p, ctx) => p.getStatus(ctx) });
      // only the mock module can be "fiscalized" later; a real module must sign every receipt itself
      ok(res, { fiscalEnabled: true, configured: true, provider: terminal.fiscal.provider, moduleId: terminal.fiscal.moduleId, supportsOffline: terminal.fiscal.provider === 'mock', ...status });
    } catch {
      ok(res, { fiscalEnabled: true, configured: true, provider: terminal.fiscal.provider, online: false, supportsOffline: false, message: 'unreachable' });
    }
  }),
);

/** Request/response log of fiscal calls (secrets removed). */
fiscalRouter.get(
  '/logs',
  requirePermission('reports.view'),
  validate({ query: paginationSchema.extend({ terminalId: objectId.optional(), status: z.enum(['ok', 'error', 'timeout']).optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const filter: Record<string, unknown> = {};
    if (q.terminalId) filter.terminalId = oid(q.terminalId);
    if (q.status) filter.status = q.status;
    const { items, meta } = await repo(req, FiscalLog).paginate(filter, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((l) => l.toJSON()), meta);
  }),
);

/** Receipts of fiscal shops that carry no fiscal data, for the "Fiscal receipts" report. */
fiscalRouter.get(
  '/providers',
  h(async (_req, res) => ok(res, fiscalProviderNames())),
);

