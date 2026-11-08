import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  objectId,
  paginationSchema,
  priceBulkSchema,
  priceCopySchema,
  priceMatrixQuerySchema,
  priceMatrixUpdateSchema,
  scheduledPriceSchema,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { escapeRegex, oid } from '../../lib/util';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo, shopId } from '../../lib/http';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Price, PriceChange, Product } from '../../models/catalog';
import { Branch } from '../../models/core';
import { categoryWithDescendants } from './categories';
import { applyPrices } from './priceService';

export const pricesRouter = Router();
pricesRouter.use(authenticate, requirePermission('prices.view', 'products.view'));

/** Selling prices can be changed by the shop admin only - no permission can delegate this. */
function requireShopAdmin(req: Request) {
  if (auth(req).role !== 'shop_admin') throw forbidden('PRICE_ADMIN_ONLY');
}

const adminOnly = (req: Request, _res: unknown, next: (e?: unknown) => void) => {
  try {
    requireShopAdmin(req);
    next();
  } catch (e) {
    next(e);
  }
};

/** Branches the caller can see prices for. */
async function visibleBranches(req: Request) {
  const a = auth(req);
  const filter: Record<string, unknown> = a.role === 'shop_admin' ? {} : { _id: { $in: a.branchIds } };
  return repo(req, Branch).find({ ...filter, isActive: true }, { sort: 'name' });
}

/* -------------------------------------------------------------------------- reads */

/** Flat price list of one branch. */
pricesRouter.get(
  '/',
  validate({ query: paginationSchema.extend({ branchId: objectId, limit: z.coerce.number().int().min(1).max(5000).default(100) }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const a = auth(req);
    if (a.role !== 'shop_admin' && !a.branchIds.some((b) => String(b) === q.branchId)) throw forbidden();
    const { items, meta } = await repo(req, Price).paginate({ branchId: q.branchId }, { page: q.page, limit: q.limit, sort: 'productId' });
    ok(res, items.map((p) => ({ productId: String(p.productId), branchId: String(p.branchId), price: p.price })), meta);
  }),
);

/** Matrix: products as rows, branches as columns (spec 5.5). */
pricesRouter.get(
  '/matrix',
  validate({ query: priceMatrixQuerySchema }),
  h(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof priceMatrixQuerySchema>;
    const branches = await visibleBranches(req);
    const filter: Record<string, any> = { isActive: true, deletedAt: null };
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ name: rx }, { sku: rx }, { barcodes: new RegExp('^' + escapeRegex(q.q)) }];
    }
    if (q.categoryId) filter.categoryId = { $in: await categoryWithDescendants(req, q.categoryId) };

    if (q.missingOnly) {
      // products lacking a price in at least one visible branch
      const priced = await repo(req, Price)
        .aggregate([
          { $match: { branchId: { $in: branches.map((b) => b._id) } } },
          { $group: { _id: '$productId', n: { $sum: 1 } } },
          { $match: { n: { $gte: branches.length } } },
        ]);
      filter._id = { $nin: priced.map((p: any) => p._id) };
    }

    const [products, total] = await Promise.all([
      repo(req, Product).find(filter, { sort: 'name', select: 'name sku barcodes categoryId unit' }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      repo(req, Product).count(filter),
    ]);
    const prices = await repo(req, Price)
      .find({ productId: { $in: products.map((p) => p._id) }, branchId: { $in: branches.map((b) => b._id) } })
      .select('productId branchId price')
      .lean();
    const byProduct = new Map<string, Record<string, number>>();
    for (const p of prices) {
      const k = String(p.productId);
      if (!byProduct.has(k)) byProduct.set(k, {});
      byProduct.get(k)![String(p.branchId)] = p.price as number;
    }
    ok(
      res,
      {
        branches: branches.map((b) => ({ id: String(b._id), name: b.name })),
        products: products.map((p) => ({
          id: String(p._id),
          name: p.name,
          sku: p.sku,
          barcodes: p.barcodes,
          categoryId: p.categoryId ? String(p.categoryId) : null,
          unit: p.unit,
          prices: byProduct.get(String(p._id)) ?? {},
        })),
      },
      { page: q.page, limit: q.limit, total },
    );
  }),
);

pricesRouter.get(
  '/history',
  validate({ query: paginationSchema.extend({ productId: objectId, branchId: objectId.optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const filter: Record<string, unknown> = { productId: q.productId, status: 'applied' };
    if (q.branchId) filter.branchId = q.branchId;
    const { items, meta } = await repo(req, PriceChange).paginate(filter, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((c) => c.toJSON()), meta);
  }),
);

/* ------------------------------------------------------------------------- writes */

pricesRouter.put(
  '/',
  adminOnly,
  validate({ body: priceMatrixUpdateSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const applied = await applyPrices({ shopId: shopId(req), userId: a.userId, changes: req.body.changes, source: 'manual' });
    await audit(req, { action: 'prices.changed', entity: 'price', meta: { count: applied.length, sample: applied.slice(0, 50) } });
    ok(res, { changed: applied.length });
  }),
);

pricesRouter.post(
  '/copy',
  adminOnly,
  validate({ body: priceCopySchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof priceCopySchema>;
    const branchRepo = repo(req, Branch);
    const ids = [b.fromBranchId, ...b.toBranchIds];
    if ((await branchRepo.count({ _id: { $in: ids } })) !== new Set(ids).size) throw notFound('BRANCH_NOT_FOUND');
    const source = await repo(req, Price).find({ branchId: b.fromBranchId }).select('productId price').lean();
    const changes: any[] = [];
    for (const to of b.toBranchIds) {
      if (to === b.fromBranchId) continue;
      let skip = new Set<string>();
      if (!b.overwrite) {
        const have = await repo(req, Price).find({ branchId: to }).select('productId').lean();
        skip = new Set(have.map((h) => String(h.productId)));
      }
      for (const p of source) if (!skip.has(String(p.productId))) changes.push({ productId: p.productId, branchId: to, price: p.price });
    }
    const applied = await applyPrices({ shopId: shopId(req), userId: a.userId, changes, source: 'copy' });
    await audit(req, { action: 'prices.copied', entity: 'price', meta: { from: b.fromBranchId, to: b.toBranchIds, count: applied.length, overwrite: b.overwrite } });
    ok(res, { changed: applied.length });
  }),
);

/** Percentage or fixed change for a selection or a whole category, in one or several branches. */
pricesRouter.post(
  '/bulk',
  adminOnly,
  validate({ body: priceBulkSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof priceBulkSchema>;
    const filter: Record<string, any> = { branchId: { $in: b.branchIds.map(oid) } };
    if (b.productIds?.length) filter.productId = { $in: b.productIds.map(oid) };
    else if (b.categoryId) {
      const cats = await categoryWithDescendants(req, b.categoryId);
      const products = await repo(req, Product).find({ categoryId: { $in: cats } }).select('_id').lean();
      filter.productId = { $in: products.map((p) => p._id) };
    }
    const prices = await repo(req, Price).find(filter).select('productId branchId price').lean();
    const changes = prices
      .map((p) => {
        const old = p.price as number;
        const next = b.mode === 'percent' ? Math.round(old * (1 + b.value / 100)) : Math.round(old + b.value);
        return { productId: p.productId, branchId: p.branchId, price: next };
      })
      .filter((c) => c.price > 0);
    const applied = await applyPrices({ shopId: shopId(req), userId: a.userId, changes, source: 'bulk' });
    await audit(req, { action: 'prices.bulk_changed', entity: 'price', meta: { mode: b.mode, value: b.value, branches: b.branchIds, count: applied.length } });
    ok(res, { changed: applied.length, skippedNonPositive: prices.length - changes.length });
  }),
);

/* --------------------------------------------------------------- scheduled changes */

export const priceChangesRouter = Router();
priceChangesRouter.use(authenticate, requirePermission('prices.view', 'products.view'));

priceChangesRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(['scheduled', 'applied', 'cancelled']).default('scheduled'),
      productId: objectId.optional(),
      branchId: objectId.optional(),
    }),
  }),
  h(async (req, res) => {
    const q = req.query as any;
    const filter: Record<string, unknown> = { status: q.status };
    if (q.productId) filter.productId = q.productId;
    if (q.branchId) filter.branchId = q.branchId;
    const { items, meta } = await repo(req, PriceChange).paginate(filter, { page: q.page, limit: q.limit, sort: q.status === 'scheduled' ? 'effectiveAt' : '-createdAt' });
    ok(res, items.map((c) => c.toJSON()), meta);
  }),
);

priceChangesRouter.post(
  '/',
  adminOnly,
  validate({ body: scheduledPriceSchema }),
  h(async (req, res) => {
    const b = req.body as z.infer<typeof scheduledPriceSchema>;
    if (b.effectiveAt.getTime() <= Date.now()) throw unprocessable('SCHEDULE_IN_PAST');
    if (!(await repo(req, Product).exists({ _id: b.productId }))) throw notFound('PRODUCT_NOT_FOUND');
    if (!(await repo(req, Branch).exists({ _id: b.branchId }))) throw notFound('BRANCH_NOT_FOUND');
    const change = await repo(req, PriceChange).create({
      productId: b.productId,
      branchId: b.branchId,
      newPrice: b.newPrice,
      effectiveAt: b.effectiveAt,
      status: 'scheduled',
      userId: auth(req).userId,
      source: 'scheduled',
    });
    await audit(req, { action: 'prices.scheduled', entity: 'price_change', entityId: change._id, after: change });
    created(res, change.toJSON());
  }),
);

priceChangesRouter.delete(
  '/:id',
  adminOnly,
  validate({ params: z.object({ id: objectId }) }),
  h(async (req, res) => {
    const c = await repo(req, PriceChange).findOneAndUpdate({ _id: req.params.id, status: 'scheduled' }, { $set: { status: 'cancelled' } });
    if (!c) throw notFound();
    await audit(req, { action: 'prices.schedule_cancelled', entity: 'price_change', entityId: c._id });
    ok(res, c.toJSON());
  }),
);
