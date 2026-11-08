import { Router } from 'express';
import { auditQuerySchema } from '@kass/shared';
import { h, ok, repo } from '../../lib/http';
import { oid } from '../../lib/util';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { AuditLog } from '../../models/core';

/** The shop's own audit trail (spec 2.1: shop admin only). Platform entries are never visible here. */
export const auditLogRouter = Router();
auditLogRouter.use(authenticate, requirePermission('audit.view'));

auditLogRouter.get(
  '/',
  validate({ query: auditQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const f: Record<string, any> = {};
    if (q.action) f.action = q.action;
    if (q.entity) f.entity = q.entity;
    if (q.entityId) f.entityId = q.entityId;
    if (q.userId) f.userId = oid(q.userId);
    if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repo(req, AuditLog).paginate(f, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((i) => i.toJSON()), meta);
  }),
);
