import { Router, type Request } from 'express';
import { z } from 'zod';
import { dateOnly, objectId, paginationSchema, productInputSchema, saleInputSchema } from '@kass/shared';
import { AppError, forbidden, notFound } from '../../lib/errors';
import { h, ok } from '../../lib/http';
import { escapeRegex, oid } from '../../lib/util';
import { validate } from '../../middleware/core';
import { Price, Product } from '../../models/catalog';
import { Branch, Terminal } from '../../models/core';
import { Customer, Sale, Shift } from '../../models/sales';
import { Stock } from '../../models/stock';
import { dailyTotals } from '../reports/daily';
import { createSale } from '../pos/saleService';
import { TenantRepo } from '../../repo/tenantRepo';
import type { AuthContext } from '../../types';
import { authenticateApiKey, requireScope } from './apiKeys';
import { tashkentDateString } from '@kass/shared';
import { AuditLog } from '../../models/core';

export const publicRouter = Router();
publicRouter.use(authenticateApiKey);

const repoOf = <T>(req: Request, model: any) => new TenantRepo<T>(model, req.apiKey!.shopId);

/** A key bound to one branch can only ever see and use that branch. */
function branchFor(req: Request, requested?: string): string | undefined {
  const bound = req.apiKey!.branchId ? String(req.apiKey!.branchId) : undefined;
  if (bound && requested && requested !== bound) throw forbidden();
  return bound ?? requested;
}

const present = (p: any) => ({
  id: String(p._id),
  name: p.name,
  sku: p.sku ?? null,
  barcodes: p.barcodes,
  categoryId: p.categoryId ? String(p.categoryId) : null,
  unit: p.unit,
  isWeighted: p.isWeighted,
  vatRate: p.vatRate ?? null,
  mxikCode: p.mxikCode ?? null,
  packageCode: p.packageCode ?? null,
  isActive: p.isActive,
  updatedAt: p.updatedAt,
});

/* ================================================================== products */

publicRouter.get(
  '/products',
  requireScope('products:read'),
  validate({ query: paginationSchema.extend({ categoryId: objectId.optional(), updatedSince: z.coerce.date().optional(), active: z.enum(['true', 'false']).optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const f: Record<string, any> = { deletedAt: null };
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      f.$or = [{ name: rx }, { sku: rx }, { barcodes: new RegExp('^' + escapeRegex(q.q)) }];
    }
    if (q.categoryId) f.categoryId = oid(q.categoryId);
    if (q.active) f.isActive = q.active === 'true';
    if (q.updatedSince) f.updatedAt = { $gt: q.updatedSince };
    const { items, meta } = await repoOf(req, Product).paginate(f, { page: q.page, limit: q.limit, sort: 'name' });
    ok(res, items.map(present), meta);
  }),
);

publicRouter.get(
  '/products/by-barcode/:barcode',
  requireScope('products:read'),
  validate({ query: z.object({ branchId: objectId.optional() }) }),
  h(async (req, res) => {
    const p = await repoOf<any>(req, Product).findOne({ barcodes: String(req.params.barcode) });
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const branchId = branchFor(req, (req.query as any).branchId);
    let price: number | null | undefined;
    if (branchId && req.apiKey!.scopes.has('prices:read')) price = (await repoOf<any>(req, Price).findOne({ productId: p._id, branchId }))?.price ?? null;
    ok(res, { ...present(p), ...(price !== undefined ? { price } : {}) });
  }),
);

publicRouter.post(
  '/products',
  requireScope('products:write'),
  h(async (req, res, next) => {
    // Prices are set only by the shop owner in the panel - never through the public API.
    if (req.body && typeof req.body === 'object' && 'prices' in req.body) throw forbidden('PRICE_ADMIN_ONLY');
    next();
  }),
  validate({ body: productInputSchema.omit({ prices: true }) }),
  h(async (req, res) => {
    const input = req.body;
    input.barcodes = [...new Set(input.barcodes ?? [])];
    const r = repoOf<any>(req, Product);
    if (input.barcodes.length) {
      const clash = await r.findOne({ barcodes: { $in: input.barcodes } }).select('name').lean();
      if (clash) throw new AppError(409, 'DUPLICATE_BARCODE', undefined, { productId: String((clash as any)._id) });
    }
    const p = await r.create({ ...input, categoryId: input.categoryId ? oid(input.categoryId) : null });
    await AuditLog.create({ shopId: req.apiKey!.shopId, action: 'product.created', entity: 'product', entityId: String(p._id), meta: { via: 'api_key', keyId: String(req.apiKey!.keyId) } });
    res.status(201).json({ data: present(p) });
  }),
);

publicRouter.patch(
  '/products/:id',
  requireScope('products:write'),
  validate({
    params: z.object({ id: objectId }),
    body: productInputSchema.pick({ name: true, barcodes: true, categoryId: true }).partial().strict(),
  }),
  h(async (req, res) => {
    const r = repoOf<any>(req, Product);
    const p = await r.findById(req.params.id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    if (req.body.barcodes) {
      const clash = await r.findOne({ barcodes: { $in: req.body.barcodes }, _id: { $ne: p._id } }).select('_id').lean();
      if (clash) throw new AppError(409, 'DUPLICATE_BARCODE');
      p.barcodes = [...new Set(req.body.barcodes as string[])];
    }
    if (req.body.name) p.name = req.body.name;
    if (req.body.categoryId !== undefined) p.categoryId = req.body.categoryId ? oid(req.body.categoryId) : null;
    await p.save();
    ok(res, present(p));
  }),
);

/* ============================================================ prices and stock */

publicRouter.get(
  '/prices',
  requireScope('prices:read'),
  validate({ query: paginationSchema.extend({ branchId: objectId, limit: z.coerce.number().int().min(1).max(1000).default(100) }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const branchId = branchFor(req, q.branchId)!;
    if (!(await repoOf(req, Branch).exists({ _id: branchId }))) throw notFound('BRANCH_NOT_FOUND');
    const { items, meta } = await repoOf<any>(req, Price).paginate({ branchId }, { page: q.page, limit: q.limit, sort: 'productId' });
    ok(res, items.map((p: any) => ({ productId: String(p.productId), branchId: String(p.branchId), price: p.price, updatedAt: p.updatedAt })), meta);
  }),
);

publicRouter.get(
  '/stock',
  requireScope('stock:read'),
  validate({ query: paginationSchema.extend({ branchId: objectId, limit: z.coerce.number().int().min(1).max(1000).default(100) }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const branchId = branchFor(req, q.branchId)!;
    if (!(await repoOf(req, Branch).exists({ _id: branchId }))) throw notFound('BRANCH_NOT_FOUND');
    const { items, meta } = await repoOf<any>(req, Stock).paginate({ branchId }, { page: q.page, limit: q.limit, sort: 'productId' });
    ok(res, items.map((s: any) => ({ productId: String(s.productId), branchId: String(s.branchId), quantity: s.quantity, minStock: s.minStock })), meta);
  }),
);

/* ===================================================================== sales */

const presentSale = (s: any) => ({
  id: String(s._id),
  number: s.number,
  branchId: String(s.branchId),
  createdAt: s.createdAt,
  total: s.total,
  discount: s.discount,
  currency: s.currency,
  status: s.status,
  customerId: s.customerId ? String(s.customerId) : null,
  payments: s.payments,
  fiscal: s.fiscal?.sign ? { sign: s.fiscal.sign, receiptId: s.fiscal.receiptId } : null,
  lines: s.lines?.map((l: any) => ({ productId: String(l.productId), name: l.name, qty: l.qty, price: l.price, total: l.total })),
});

publicRouter.get(
  '/sales',
  requireScope('sales:read'),
  validate({ query: paginationSchema.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional(), number: z.string().max(40).optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const f: Record<string, any> = {};
    const branchId = branchFor(req, q.branchId);
    if (branchId) f.branchId = oid(branchId);
    if (q.number) f.number = q.number;
    if (q.from || q.to) f.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repoOf<any>(req, Sale).paginate(f, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((s: any) => ({ ...presentSale(s), lines: undefined })), meta);
  }),
);

publicRouter.get(
  '/sales/:id',
  requireScope('sales:read'),
  validate({ params: z.object({ id: objectId }) }),
  h(async (req, res) => {
    const s = await repoOf<any>(req, Sale).findById(req.params.id);
    const bound = req.apiKey!.branchId;
    if (!s || (bound && String(s.branchId) !== String(bound))) throw notFound('SALE_NOT_FOUND');
    ok(res, presentSale(s));
  }),
);

/**
 * Register a sale from an external system. It is booked on an open shift of a terminal the shop
 * set aside for the integration and acts with the minimal rights of that shift's cashier: no
 * credit, no bonus approval, no discount override.
 */
publicRouter.post(
  '/sales',
  requireScope('sales:write'),
  validate({ body: saleInputSchema.omit({ approval: true, isOffline: true, createdAt: true, localNumber: true }).strict() }),
  h(async (req, res) => {
    const key = req.apiKey!;
    const shift = await repoOf<any>(req, Shift).findOne({ _id: req.body.shiftId, terminalId: req.body.terminalId, status: 'open' });
    if (!shift) throw notFound('SHIFT_NOT_FOUND');
    const terminal = await repoOf<any>(req, Terminal).findById(req.body.terminalId);
    if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
    if (key.branchId && String(terminal.branchId) !== String(key.branchId)) throw forbidden();
    const ctx = {
      kind: 'user',
      userId: shift.cashierId,
      role: 'cashier',
      shopId: key.shopId,
      branchIds: [terminal.branchId],
      permissions: new Set(['sales.create']),
      user: { fullName: shift.cashierName },
      shop: key.shop,
      graceDaysLeft: null,
    } as unknown as AuthContext;
    const r = await createSale(ctx, { ...req.body, isOffline: false } as any, { ip: req.ip });
    res.status(r.duplicate ? 200 : 201).json({ data: { ...presentSale(r.sale), duplicate: r.duplicate, warnings: r.warnings } });
  }),
);

/* =============================================== customers and daily report */

publicRouter.get(
  '/customers',
  requireScope('customers:read'),
  validate({ query: paginationSchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const f: Record<string, any> = {};
    if (q.q) f.$or = [{ fullName: new RegExp(escapeRegex(q.q), 'i') }, { phone: new RegExp(escapeRegex(q.q.replace(/[\s()-]/g, ''))) }];
    const { items, meta } = await repoOf<any>(req, Customer).paginate(f, { page: q.page, limit: q.limit, sort: 'fullName' });
    ok(res, items.map((c: any) => ({ id: String(c._id), fullName: c.fullName, phone: c.phone, cardBarcode: c.cardBarcode ?? null, bonusBalance: c.bonusBalance, debtBalance: c.debtBalance })), meta);
  }),
);

publicRouter.get(
  '/reports/daily',
  requireScope('reports:read'),
  validate({ query: z.object({ from: dateOnly.optional(), to: dateOnly.optional(), branchId: objectId.optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const today = tashkentDateString(new Date());
    const branchId = branchFor(req, q.branchId);
    const rows = await dailyTotals(req.apiKey!.shopId, branchId ? [oid(branchId)] : null, q.from ?? today, q.to ?? today);
    ok(res, rows.map((r) => ({ date: r.date, branchId: r.branchId, branchName: r.branchName, receipts: r.receipts, revenue: r.revenue, discounts: r.discounts, returns: r.returns, netRevenue: r.netRevenue })));
  }),
);
