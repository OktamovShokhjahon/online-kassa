import { Router } from 'express';
import { z } from 'zod';
import {
  customerInputSchema,
  customerListQuerySchema,
  customerPaymentSchema,
  customerUpdateSchema,
  normalizePhone,
  objectId,
  paginationSchema,
  promotionInputSchema,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import { escapeRegex, oid, parseSort } from '../../lib/util';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch } from '../../models/core';
import { BonusTransaction, Customer, CustomerPayment, Promotion, Sale, Shift } from '../../models/sales';
import { Category, Product } from '../../models/catalog';

const idParams = validate({ params: z.object({ id: objectId }) });

/* ============================================================================ customers */

export const customersRouter = Router();
customersRouter.use(authenticate);

const VIEW = ['customers.view', 'customers.manage', 'customers.create', 'sales.create'];

customersRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: customerListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const filter: Record<string, any> = {};
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ fullName: rx }, { phone: new RegExp(escapeRegex(q.q.replace(/[\s()-]/g, ''))) }, { cardBarcode: q.q }];
    }
    if (q.debtOnly) filter.debtBalance = { $gt: 0 };
    const { items, meta } = await repo(req, Customer).paginate(filter, { page: q.page, limit: q.limit, sort: parseSort(q.sort, ['fullName', 'debtBalance', 'totalSpent', 'lastVisitAt', 'createdAt'], 'fullName') });
    ok(res, items.map((c) => c.toJSON()), meta);
  }),
);

/** POS lookup by phone (any format) or by loyalty card barcode. */
customersRouter.get(
  '/by-phone/:phone',
  requirePermission(...VIEW),
  h(async (req, res) => {
    const phone = normalizePhone(String(req.params.phone));
    const c = phone ? await repo(req, Customer).findOne({ phone }) : null;
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    ok(res, c.toJSON());
  }),
);

customersRouter.get(
  '/by-card/:code',
  requirePermission(...VIEW),
  h(async (req, res) => {
    const c = await repo(req, Customer).findOne({ cardBarcode: String(req.params.code) });
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    ok(res, c.toJSON());
  }),
);

customersRouter.post(
  '/',
  requirePermission('customers.manage', 'customers.create'),
  validate({ body: customerInputSchema }),
  h(async (req, res) => {
    const r = repo(req, Customer);
    if (await r.exists({ phone: req.body.phone })) throw conflict('DUPLICATE_PHONE');
    if (req.body.cardBarcode && (await r.exists({ cardBarcode: req.body.cardBarcode }))) throw conflict('DUPLICATE_CARD');
    // Only users who manage customers may set a credit limit.
    const input = { ...req.body };
    if (!auth(req).permissions.has('customers.manage') && auth(req).role !== 'shop_admin') delete input.creditLimit;
    const c = await r.create(input);
    await audit(req, { action: 'customer.created', entity: 'customer', entityId: c._id });
    created(res, c.toJSON());
  }),
);

customersRouter.get(
  '/:id',
  idParams,
  requirePermission(...VIEW),
  h(async (req, res) => {
    const c = await repo(req, Customer).findById(req.params.id);
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    ok(res, c.toJSON());
  }),
);

customersRouter.patch(
  '/:id',
  idParams,
  requirePermission('customers.manage'),
  validate({ body: customerUpdateSchema }),
  h(async (req, res) => {
    const r = repo(req, Customer);
    const c = await r.findById(req.params.id);
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    if (req.body.phone && req.body.phone !== c.phone && (await r.exists({ phone: req.body.phone }))) throw conflict('DUPLICATE_PHONE');
    if (req.body.cardBarcode && req.body.cardBarcode !== c.cardBarcode && (await r.exists({ cardBarcode: req.body.cardBarcode }))) throw conflict('DUPLICATE_CARD');
    const before = c.toObject();
    Object.assign(c, req.body);
    await c.save();
    await audit(req, { action: 'customer.updated', entity: 'customer', entityId: c._id, before, after: c });
    ok(res, c.toJSON());
  }),
);

/** Purchase history, total spent, average receipt, last visit, bonus ledger and payments. */
customersRouter.get(
  '/:id/history',
  idParams,
  requirePermission('customers.view', 'customers.manage'),
  validate({ query: paginationSchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const c = await repo(req, Customer).findById(req.params.id);
    if (!c) throw notFound('CUSTOMER_NOT_FOUND');
    const [{ items, meta }, bonus, payments] = await Promise.all([
      repo(req, Sale).paginate({ customerId: c._id }, { page: q.page, limit: q.limit, sort: '-createdAt' }),
      repo(req, BonusTransaction).find({ customerId: c._id }, { sort: '-createdAt' }).limit(50),
      repo(req, CustomerPayment).find({ customerId: c._id }, { sort: '-createdAt' }).limit(50),
    ]);
    ok(
      res,
      {
        customer: c.toJSON(),
        stats: { totalSpent: c.totalSpent, receipts: c.receiptCount, averageReceipt: c.receiptCount ? Math.round(c.totalSpent / c.receiptCount) : 0, lastVisitAt: c.lastVisitAt },
        sales: items.map((s) => ({ id: String(s._id), number: s.number, total: s.total, createdAt: s.createdAt, status: s.status })),
        bonus: bonus.map((b) => b.toJSON()),
        payments: payments.map((p) => p.toJSON()),
      },
      meta,
    );
  }),
);

/* ================================================================== debt repayments */

export const customerPaymentsRouter = Router();
customerPaymentsRouter.use(authenticate);

/**
 * Debt repayment at the POS or in the panel (spec 6.3). Cash repayments are recorded as a cash
 * operation of the cashier's open shift, so the drawer count stays correct.
 */
customerPaymentsRouter.post(
  '/',
  requirePermission('customers.manage', 'sales.create'),
  validate({ body: customerPaymentSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof customerPaymentSchema>;
    const customer = await repo(req, Customer).findById(b.customerId);
    if (!customer) throw notFound('CUSTOMER_NOT_FOUND');
    if (b.amount > customer.debtBalance) throw unprocessable('DEBT_EXCEEDS');

    const shift = await repo(req, Shift).findOne({ cashierId: a.userId, status: 'open' });
    if (b.method === 'cash' && !shift) throw unprocessable('NO_OPEN_SHIFT');
    const updated = await repo(req, Customer).findOneAndUpdate({ _id: customer._id, debtBalance: { $gte: b.amount } }, { $inc: { debtBalance: -b.amount }, ...(customer.debtBalance - b.amount <= 0 ? { $unset: { debtSince: '' } } : {}) });
    if (!updated) throw unprocessable('DEBT_EXCEEDS');
    const payment = await repo(req, CustomerPayment).create({ customerId: customer._id, shiftId: shift?._id, branchId: shift?.branchId, amount: b.amount, method: b.method, createdBy: a.userId });
    await audit(req, { action: 'customer.debt_repaid', entity: 'customer', entityId: customer._id, meta: { amount: b.amount, method: b.method } });
    created(res, { payment: payment.toJSON(), debtBalance: updated.debtBalance });
  }),
);

customerPaymentsRouter.get(
  '/',
  requirePermission('customers.manage', 'customers.view'),
  validate({ query: paginationSchema.extend({ customerId: objectId.optional() }) }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, CustomerPayment).paginate(q.customerId ? { customerId: q.customerId } : {}, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((p) => p.toJSON()), meta);
  }),
);

/* ============================================================================ promotions */

export const promotionsRouter = Router();
promotionsRouter.use(authenticate);

async function checkRefs(req: any, b: z.infer<typeof promotionInputSchema>) {
  const productIds = [...(b.rules.productIds ?? []), ...(b.rules.items ?? []).map((i) => i.productId)];
  if (productIds.length && (await repo(req, Product).count({ _id: { $in: productIds } })) !== new Set(productIds).size) throw notFound('PRODUCT_NOT_FOUND');
  if (b.rules.categoryIds?.length && (await repo(req, Category).count({ _id: { $in: b.rules.categoryIds } })) !== new Set(b.rules.categoryIds).size) throw notFound();
  if (b.branchIds.length && (await repo(req, Branch).count({ _id: { $in: b.branchIds } })) !== new Set(b.branchIds).size) throw notFound('BRANCH_NOT_FOUND');
}

promotionsRouter.get(
  '/',
  requirePermission('promotions.manage', 'products.view'),
  h(async (req, res) => {
    const items = await repo(req, Promotion).find({}, { sort: '-priority -createdAt' });
    ok(res, items.map((p) => p.toJSON()));
  }),
);

promotionsRouter.post(
  '/',
  requirePermission('promotions.manage'),
  validate({ body: promotionInputSchema }),
  h(async (req, res) => {
    await checkRefs(req, req.body);
    const p = await repo(req, Promotion).create({ ...req.body, branchIds: req.body.branchIds.map(oid) });
    await audit(req, { action: 'promotion.created', entity: 'promotion', entityId: p._id, after: p });
    created(res, p.toJSON());
  }),
);

promotionsRouter.get(
  '/:id',
  idParams,
  requirePermission('promotions.manage', 'products.view'),
  h(async (req, res) => {
    const p = await repo(req, Promotion).findById(req.params.id);
    if (!p) throw notFound('PROMOTION_NOT_FOUND');
    ok(res, p.toJSON());
  }),
);

promotionsRouter.put(
  '/:id',
  idParams,
  requirePermission('promotions.manage'),
  validate({ body: promotionInputSchema }),
  h(async (req, res) => {
    const p = await repo(req, Promotion).findById(req.params.id);
    if (!p) throw notFound('PROMOTION_NOT_FOUND');
    await checkRefs(req, req.body);
    const before = p.toObject();
    p.set({ ...req.body, branchIds: req.body.branchIds.map(oid), startsAt: req.body.startsAt ?? undefined, endsAt: req.body.endsAt ?? undefined, schedule: req.body.schedule ?? null });
    await p.save();
    await audit(req, { action: 'promotion.updated', entity: 'promotion', entityId: p._id, before, after: p });
    ok(res, p.toJSON());
  }),
);

promotionsRouter.delete(
  '/:id',
  idParams,
  requirePermission('promotions.manage'),
  h(async (req, res) => {
    const p = await repo(req, Promotion).findById(req.params.id);
    if (!p) throw notFound('PROMOTION_NOT_FOUND');
    await repo(req, Promotion).deleteOne({ _id: p._id });
    await audit(req, { action: 'promotion.deleted', entity: 'promotion', entityId: p._id, before: p });
    ok(res, { deleted: true });
  }),
);
