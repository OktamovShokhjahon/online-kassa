import { Router, type Request } from 'express';
import { z } from 'zod';
import { minStockSchema, movementQuerySchema, objectId, paginationSchema, stockQuerySchema } from '@kass/shared';
import { audit } from '../../lib/audit';
import { forbidden, notFound } from '../../lib/errors';
import { auth, h, ok, repo } from '../../lib/http';
import { escapeRegex, oid } from '../../lib/util';
import { assertBranchAccess, authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Price, Product } from '../../models/catalog';
import { Branch } from '../../models/core';
import { Stock, StockMovement } from '../../models/stock';
import { categoryWithDescendants } from '../catalog/categories';

export const stockRouter = Router();
stockRouter.use(authenticate, requirePermission('stock.view', 'stock.receipt', 'stock.transfer', 'stock.writeoff', 'stock.count', 'reports.stock', 'reports.view'));

/** Mongo condition for a stock status filter (shared by the list, low and negative reports). */
export function stockStatusFilter(status?: string): Record<string, unknown> {
  switch (status) {
    case 'low':
      return { minStock: { $gt: 0 }, $expr: { $lte: ['$quantity', '$minStock'] } };
    case 'negative':
      return { quantity: { $lt: 0 } };
    case 'zero':
      return { quantity: 0 };
    case 'positive':
      return { quantity: { $gt: 0 } };
    default:
      return {};
  }
}

/** Branch ids the caller may query; throws if a requested one is not allowed. */
async function branchesFor(req: Request, requested?: string) {
  const a = auth(req);
  if (requested) {
    if (!(await repo(req, Branch).exists({ _id: requested }))) throw notFound('BRANCH_NOT_FOUND');
    assertBranchAccess(req, requested);
    return [oid(requested)];
  }
  if (a.role === 'shop_admin') return (await repo(req, Branch).find({}).select('_id').lean()).map((b) => b._id);
  return a.branchIds;
}

async function decorate(req: Request, rows: any[], branchId?: string) {
  const ids = rows.map((r) => r.productId);
  const [products, prices] = await Promise.all([
    repo(req, Product).find({ _id: { $in: ids } }).select('name sku barcodes unit categoryId').lean(),
    repo(req, Price).find({ productId: { $in: ids }, ...(branchId ? { branchId } : {}) }).select('productId branchId price').lean(),
  ]);
  const pm = new Map(products.map((p) => [String(p._id), p]));
  const prm = new Map(prices.map((p) => [`${p.productId}:${p.branchId}`, p.price as number]));
  return rows.map((r) => {
    const p = pm.get(String(r.productId));
    const price = prm.get(`${r.productId}:${r.branchId}`) ?? null;
    return {
      productId: String(r.productId),
      branchId: String(r.branchId),
      name: p?.name,
      sku: p?.sku,
      barcode: p?.barcodes?.[0],
      unit: p?.unit,
      categoryId: p?.categoryId ? String(p.categoryId) : null,
      quantity: r.quantity,
      avgCost: r.avgCost,
      minStock: r.minStock ?? 0,
      price,
      valueAtCost: Math.round(r.quantity * r.avgCost),
      valueAtPrice: price === null ? null : Math.round(r.quantity * price),
    };
  });
}

/** Stock balance per product for a branch, valued at average cost and at the selling price. */
stockRouter.get(
  '/',
  validate({ query: stockQuerySchema }),
  h(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof stockQuerySchema>;
    const [branch] = await branchesFor(req, q.branchId);
    const filter: Record<string, any> = { branchId: branch, ...stockStatusFilter(q.status) };
    if (q.q || q.categoryId) {
      const pf: Record<string, any> = {};
      if (q.q) {
        const rx = new RegExp(escapeRegex(q.q), 'i');
        pf.$or = [{ name: rx }, { sku: rx }, { barcodes: new RegExp('^' + escapeRegex(q.q)) }];
      }
      if (q.categoryId) pf.categoryId = { $in: await categoryWithDescendants(req, q.categoryId) };
      filter.productId = { $in: (await repo(req, Product).find(pf).select('_id').lean()).map((p) => p._id) };
    }
    const { items, meta } = await repo(req, Stock).paginate(filter, { page: q.page, limit: q.limit, sort: 'productId' });
    const rows = await decorate(req, items.map((i) => i.toObject()), String(branch));
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // totals over the whole filter (not just this page)
    const totals = await repo(req, Stock).aggregate([
      { $match: { ...filter, branchId: branch } },
      { $lookup: { from: 'prices', let: { p: '$productId' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$productId', '$$p'] }, { $eq: ['$branchId', branch] }] } } }, { $project: { price: 1 } }], as: 'pr' } },
      { $group: { _id: null, quantity: { $sum: '$quantity' }, valueAtCost: { $sum: { $round: [{ $multiply: ['$quantity', '$avgCost'] }, 0] } }, valueAtPrice: { $sum: { $round: [{ $multiply: ['$quantity', { $ifNull: [{ $arrayElemAt: ['$pr.price', 0] }, 0] }] }, 0] } } } },
    ]);
    ok(res, rows, { ...meta, totals: totals[0] ? { quantity: totals[0].quantity, valueAtCost: totals[0].valueAtCost, valueAtPrice: totals[0].valueAtPrice } : { quantity: 0, valueAtCost: 0, valueAtPrice: 0 } });
  }),
);

async function exceptionList(req: Request, status: 'low' | 'negative') {
  const q = req.query as any;
  const branches = await branchesFor(req, q.branchId);
  const { items, meta } = await repo(req, Stock).paginate({ branchId: { $in: branches }, ...stockStatusFilter(status) }, { page: q.page, limit: q.limit, sort: status === 'negative' ? 'quantity' : 'productId' });
  return { rows: await decorate(req, items.map((i) => i.toObject())), meta };
}

const exceptionQuery = paginationSchema.extend({ branchId: objectId.optional() });

stockRouter.get('/low', validate({ query: exceptionQuery }), h(async (req, res) => {
  const { rows, meta } = await exceptionList(req, 'low');
  ok(res, rows, meta);
}));

stockRouter.get('/negative', validate({ query: exceptionQuery }), h(async (req, res) => {
  const { rows, meta } = await exceptionList(req, 'negative');
  ok(res, rows, meta);
}));

/** Stock card: every movement of a product with the running balance. */
stockRouter.get(
  '/movements',
  validate({ query: movementQuerySchema }),
  h(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof movementQuerySchema>;
    const branches = await branchesFor(req, q.branchId);
    const filter: Record<string, any> = { branchId: { $in: branches } };
    if (q.productId) filter.productId = q.productId;
    if (q.type) filter.type = q.type;
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repo(req, StockMovement).paginate(filter, { page: q.page, limit: q.limit, sort: '-createdAt' });
    const products = await repo(req, Product).find({ _id: { $in: items.map((i) => i.productId) } }).select('name').lean();
    const pm = new Map(products.map((p) => [String(p._id), p.name]));
    ok(res, items.map((m) => ({ ...m.toJSON(), productName: pm.get(String(m.productId)) })), meta);
  }),
);

/** Low-stock threshold per branch and product. */
stockRouter.put(
  '/min-stock',
  requirePermission('stock.view', 'stock.receipt', 'stock.count'),
  validate({ body: minStockSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof minStockSchema>;
    if (a.role !== 'shop_admin' && !a.permissions.has('stock.count') && !a.permissions.has('stock.receipt')) throw forbidden();
    await branchesFor(req, b.branchId);
    const ids = b.items.map((i) => i.productId);
    if ((await repo(req, Product).count({ _id: { $in: ids } })) !== new Set(ids).size) throw notFound('PRODUCT_NOT_FOUND');
    await repo(req, Stock).bulkWrite(
      b.items.map((i) => ({
        updateOne: {
          filter: { branchId: oid(b.branchId), productId: oid(i.productId) },
          update: { $set: { minStock: i.minStock }, $setOnInsert: { quantity: 0, avgCost: 0 } },
          upsert: true,
        },
      })),
    );
    await audit(req, { action: 'stock.min_stock_set', entity: 'stock', meta: { branchId: b.branchId, count: b.items.length } });
    ok(res, { updated: b.items.length });
  }),
);

