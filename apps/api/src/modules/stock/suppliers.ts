import { Router } from 'express';
import { z } from 'zod';
import {
  objectId,
  paginationSchema,
  statementQuerySchema,
  supplierInputSchema,
  supplierPaymentSchema,
  supplierUpdateSchema,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import { escapeRegex, parseSort } from '../../lib/util';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { GoodsReceipt, Supplier, SupplierPayment, SupplierReturn } from '../../models/stock';

export const suppliersRouter = Router();
suppliersRouter.use(authenticate);
const idParams = validate({ params: z.object({ id: objectId }) });

suppliersRouter.get(
  '/',
  requirePermission('suppliers.view', 'suppliers.manage', 'stock.receipt'),
  validate({ query: paginationSchema.extend({ active: z.enum(['true', 'false']).optional(), debtOnly: z.enum(['true']).optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const filter: Record<string, any> = {};
    if (q.q) filter.name = new RegExp(escapeRegex(q.q), 'i');
    if (q.active) filter.isActive = q.active === 'true';
    if (q.debtOnly) filter.balance = { $gt: 0 };
    const { items, meta } = await repo(req, Supplier).paginate(filter, { page: q.page, limit: q.limit, sort: parseSort(q.sort, ['name', 'balance', 'createdAt'], 'name') });
    ok(res, items.map((s) => s.toJSON()), meta);
  }),
);

suppliersRouter.post(
  '/',
  requirePermission('suppliers.manage'),
  validate({ body: supplierInputSchema }),
  h(async (req, res) => {
    const s = await repo(req, Supplier).create(req.body);
    await audit(req, { action: 'supplier.created', entity: 'supplier', entityId: s._id, after: s });
    created(res, s.toJSON());
  }),
);

suppliersRouter.get(
  '/:id',
  idParams,
  requirePermission('suppliers.view', 'suppliers.manage', 'stock.receipt'),
  h(async (req, res) => {
    const s = await repo(req, Supplier).findById(req.params.id);
    if (!s) throw notFound('SUPPLIER_NOT_FOUND');
    ok(res, s.toJSON());
  }),
);

suppliersRouter.patch(
  '/:id',
  idParams,
  requirePermission('suppliers.manage'),
  validate({ body: supplierUpdateSchema }),
  h(async (req, res) => {
    const s = await repo(req, Supplier).findById(req.params.id);
    if (!s) throw notFound('SUPPLIER_NOT_FOUND');
    const before = s.toObject();
    Object.assign(s, req.body);
    await s.save();
    await audit(req, { action: 'supplier.updated', entity: 'supplier', entityId: s._id, before, after: s });
    ok(res, s.toJSON());
  }),
);

type Entry = { date: Date; type: string; docNumber?: string; docId?: string; amount: number; comment?: string };

/**
 * Supplier statement for a period (spec 5.7): opening balance, every purchase (+), return (-)
 * and payment (-) with a running balance, closing balance. Cancelled documents appear twice -
 * the original entry and its reversal - so the ledger always adds up.
 */
suppliersRouter.get(
  '/:id/statement',
  idParams,
  requirePermission('suppliers.view', 'suppliers.manage'),
  validate({ query: statementQuerySchema }),
  h(async (req, res) => {
    const supplier = await repo(req, Supplier).findById(req.params.id);
    if (!supplier) throw notFound('SUPPLIER_NOT_FOUND');
    const { from, to } = req.query as unknown as { from?: Date; to?: Date };
    const [receipts, returns, payments] = await Promise.all([
      repo(req, GoodsReceipt).find({ supplierId: supplier._id, status: { $in: ['posted', 'cancelled'] } }).lean(),
      repo(req, SupplierReturn).find({ supplierId: supplier._id, status: { $in: ['posted', 'cancelled'] } }).lean(),
      repo(req, SupplierPayment).find({ supplierId: supplier._id }).lean(),
    ]);
    const entries: Entry[] = [];
    for (const r of receipts) {
      entries.push({ date: r.postedAt!, type: 'purchase', docNumber: r.number, docId: String(r._id), amount: r.total });
      if (r.status === 'cancelled' && r.cancelledAt && r.postedAt) entries.push({ date: r.cancelledAt, type: 'purchase_reversal', docNumber: r.number, docId: String(r._id), amount: -r.total });
    }
    for (const r of returns) {
      if (!r.postedAt) continue;
      entries.push({ date: r.postedAt, type: 'return', docNumber: r.number, docId: String(r._id), amount: -r.total });
      if (r.status === 'cancelled' && r.cancelledAt) entries.push({ date: r.cancelledAt, type: 'return_reversal', docNumber: r.number, docId: String(r._id), amount: r.total });
    }
    for (const p of payments) entries.push({ date: p.paidAt, type: 'payment', docId: String(p._id), amount: -p.amount, comment: p.comment ?? undefined });
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());

    const opening = from ? entries.filter((e) => e.date < from).reduce((s, e) => s + e.amount, 0) : 0;
    let running = opening;
    const lines = entries
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .map((e) => ({ ...e, balance: (running += e.amount) }));
    ok(res, { supplier: supplier.toJSON(), openingBalance: opening, closingBalance: running, entries: lines });
  }),
);

/* ------------------------------------------------------------------- payments */

export const supplierPaymentsRouter = Router();
supplierPaymentsRouter.use(authenticate);

supplierPaymentsRouter.get(
  '/',
  requirePermission('suppliers.view', 'suppliers.pay'),
  validate({ query: paginationSchema.extend({ supplierId: objectId.optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, SupplierPayment).paginate(q.supplierId ? { supplierId: q.supplierId } : {}, { page: q.page, limit: q.limit, sort: '-paidAt' });
    ok(res, items.map((p) => p.toJSON()), meta);
  }),
);

/** Partial payments allowed; the supplier balance drops by the amount (a negative balance = prepayment). */
supplierPaymentsRouter.post(
  '/',
  requirePermission('suppliers.pay'),
  validate({ body: supplierPaymentSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = repo(req, Supplier);
    if (!(await r.exists({ _id: req.body.supplierId }))) throw notFound('SUPPLIER_NOT_FOUND');
    const payment = await repo(req, SupplierPayment).create({ ...req.body, createdBy: a.userId });
    const supplier = await r.findOneAndUpdate({ _id: req.body.supplierId }, { $inc: { balance: -req.body.amount } });
    await audit(req, { action: 'supplier.payment', entity: 'supplier', entityId: req.body.supplierId, meta: { amount: req.body.amount, paymentId: String(payment._id) } });
    created(res, { payment: payment.toJSON(), balance: supplier!.balance });
  }),
);

