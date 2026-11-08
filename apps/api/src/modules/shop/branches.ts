import { Router } from 'express';
import { z } from 'zod';
import { branchInputSchema, objectId } from '@kass/shared';
import { audit } from '../../lib/audit';
import { notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch } from '../../models/core';
import { Price, PriceChange } from '../../models/catalog';

export const branchesRouter = Router();
branchesRouter.use(authenticate);

const idParams = validate({ params: z.object({ id: objectId }) });

/** Branch managers/storekeepers/cashiers only see their own branches. */
branchesRouter.get(
  '/',
  h(async (req, res) => {
    const a = auth(req);
    const filter: Record<string, unknown> = a.role === 'shop_admin' ? {} : { _id: { $in: a.branchIds } };
    const items = await repo(req, Branch).find(filter, { sort: 'name' });
    ok(res, items.map((b) => b.toJSON()));
  }),
);

branchesRouter.get(
  '/:id',
  idParams,
  h(async (req, res) => {
    const a = auth(req);
    if (a.role !== 'shop_admin' && !a.branchIds.some((b) => String(b) === req.params.id)) throw notFound('BRANCH_NOT_FOUND');
    const branch = await repo(req, Branch).findById(req.params.id);
    if (!branch) throw notFound('BRANCH_NOT_FOUND');
    ok(res, branch.toJSON());
  }),
);

branchesRouter.post(
  '/',
  requirePermission('branches.manage'),
  validate({ body: branchInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = repo(req, Branch);
    const { copyPricesFromBranchId, ...input } = req.body as z.infer<typeof branchInputSchema>;
    const active = await r.count({ isActive: true });
    if (active >= a.shop!.limits!.maxBranches) throw unprocessable('LIMIT_REACHED');

    let source = null;
    if (copyPricesFromBranchId) {
      source = await r.findById(copyPricesFromBranchId);
      if (!source) throw notFound('BRANCH_NOT_FOUND');
    }
    const branch = await r.create(input);

    if (source) {
      // New branch starts with the source branch's selling prices; the owner can edit them later.
      const prices = await repo(req, Price).find({ branchId: source._id }).lean();
      if (prices.length) {
        const now = new Date();
        await repo(req, Price).insertMany(
          prices.map((p) => ({ productId: p.productId, branchId: branch._id, price: p.price, updatedBy: a.userId })),
        );
        await repo(req, PriceChange).insertMany(
          prices.map((p) => ({ productId: p.productId, branchId: branch._id, oldPrice: null, newPrice: p.price, effectiveAt: now, status: 'applied', userId: a.userId, source: 'branch_copy' })),
        );
      }
    }
    await audit(req, { action: 'branch.created', entity: 'branch', entityId: branch._id, after: branch, meta: { copiedPricesFrom: copyPricesFromBranchId } });
    created(res, branch.toJSON());
  }),
);

branchesRouter.patch(
  '/:id',
  idParams,
  requirePermission('branches.manage'),
  validate({ body: branchInputSchema.omit({ copyPricesFromBranchId: true }).partial() }),
  h(async (req, res) => {
    const a = auth(req);
    const r = repo(req, Branch);
    const branch = await r.findById(req.params.id);
    if (!branch) throw notFound('BRANCH_NOT_FOUND');
    const before = branch.toObject();
    if (req.body.isActive === true && !branch.isActive) {
      if ((await r.count({ isActive: true })) >= a.shop!.limits!.maxBranches) throw unprocessable('LIMIT_REACHED');
    }
    Object.assign(branch, req.body);
    await branch.save();
    await audit(req, { action: 'branch.updated', entity: 'branch', entityId: branch._id, before, after: branch });
    ok(res, branch.toJSON());
  }),
);
