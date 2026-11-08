import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  cashOperationSchema,
  objectId,
  paginationSchema,
  printJobSchema,
  refundInputSchema,
  removedLinesSchema,
  saleInputSchema,
  saleListQuerySchema,
  salesSyncSchema,
  shiftCloseSchema,
  shiftOpenSchema,
  translate,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { decrypt } from '../../lib/crypto';
import { AppError, forbidden, notFound, unprocessable } from '../../lib/errors';
import { events } from '../../lib/events';
import { runFiscal } from '../../lib/fiscal/service';
import { auth, created, h, ok, repo } from '../../lib/http';
import { escapeRegex, oid, parseSort } from '../../lib/util';
import { authenticate, canAccessBranch, requirePermission, branchScope } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Category, Price, Product } from '../../models/catalog';
import { AuditLog, Branch, Shop, Terminal, User } from '../../models/core';
import { PriceChange } from '../../models/catalog';
import { CashOperation, Customer, Refund, Sale, Shift, type SaleDoc } from '../../models/sales';
import { agentHub } from '../agent/hub';
import { buildRefundReceipt, buildSaleReceipt } from './receipt';
import { createRefund } from './refundService';
import { createSale, loadPromotionDefs } from './saleService';
import { buildShiftReport, computeShiftTotals } from './shiftService';

const idParams = validate({ params: z.object({ id: objectId }) });

/* ============================================================================ shifts */

export const shiftsRouter = Router();
shiftsRouter.use(authenticate);

async function loadShift(req: Request, id: string) {
  const a = auth(req);
  const shift = await repo(req, Shift).findById(id);
  if (!shift) throw notFound('SHIFT_NOT_FOUND');
  if (!canAccessBranch(a, shift.branchId)) throw notFound('SHIFT_NOT_FOUND');
  if (a.role === 'cashier' && String(shift.cashierId) !== String(a.userId)) throw notFound('SHIFT_NOT_FOUND');
  return shift;
}

shiftsRouter.post(
  '/open',
  requirePermission('shifts.operate'),
  validate({ body: shiftOpenSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const terminal = await repo(req, Terminal).findById(req.body.terminalId);
    if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
    if (!terminal.isActive) throw unprocessable('TERMINAL_INACTIVE');
    if (!canAccessBranch(a, terminal.branchId)) throw forbidden('TERMINAL_BRANCH_MISMATCH');

    let shift;
    try {
      shift = await repo(req, Shift).create({
        branchId: terminal.branchId,
        terminalId: terminal._id,
        cashierId: a.userId,
        cashierName: a.user.fullName,
        openingCash: req.body.openingCash,
        status: 'open',
        openedAt: new Date(),
      });
    } catch (e: any) {
      if (e?.code === 11000) throw unprocessable('SHIFT_ALREADY_OPEN');
      throw e;
    }
    if (a.shop!.fiscalEnabled) {
      try {
        const r = await runFiscal({ terminal, shop: a.shop!, docType: 'open_shift', docId: shift._id, fn: (p, ctx) => p.openShift(ctx) });
        shift.fiscalShiftId = r.fiscalShiftId;
        await shift.save();
      } catch (e) {
        await Shift.deleteOne({ _id: shift._id, shopId: a.shopId }); // nothing was opened
        throw e;
      }
    }
    await audit(req, { action: 'shift.opened', entity: 'shift', entityId: shift._id, meta: { terminalId: String(terminal._id), openingCash: shift.openingCash } });
    created(res, shift.toJSON());
  }),
);

/** The open shift of a terminal (any cashier's) so the POS knows whether it can sell. */
shiftsRouter.get(
  '/current',
  requirePermission('shifts.operate', 'sales.create'),
  validate({ query: z.object({ terminalId: objectId }) }),
  h(async (req, res) => {
    const a = auth(req);
    const terminal = await repo(req, Terminal).findById((req.query as any).terminalId);
    if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
    if (!canAccessBranch(a, terminal.branchId)) throw forbidden('TERMINAL_BRANCH_MISMATCH');
    const shift = await repo(req, Shift).findOne({ terminalId: terminal._id, status: 'open' });
    if (!shift) return ok(res, null);
    const mine = String(shift.cashierId) === String(a.userId);
    ok(res, { ...shift.toJSON(), mine, totals: mine ? await computeShiftTotals(a.shopId!, shift) : undefined });
  }),
);

shiftsRouter.get(
  '/',
  requirePermission('reports.view', 'reports.own_shift', 'shifts.operate'),
  validate({ query: paginationSchema.extend({ branchId: objectId.optional(), cashierId: objectId.optional(), status: z.enum(['open', 'closed']).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as any;
    const filter: Record<string, any> = { ...branchScope(a) };
    if (a.role === 'cashier') filter.cashierId = a.userId;
    else if (q.cashierId) filter.cashierId = q.cashierId;
    if (q.branchId) filter.branchId = oid(q.branchId);
    if (q.status) filter.status = q.status;
    if (q.from || q.to) filter.openedAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repo(req, Shift).paginate(filter, { page: q.page, limit: q.limit, sort: '-openedAt' });
    ok(res, items.map((s) => s.toJSON()), meta);
  }),
);

shiftsRouter.get(
  '/:id',
  idParams,
  requirePermission('reports.view', 'reports.own_shift', 'shifts.operate'),
  h(async (req, res) => {
    const a = auth(req);
    const shift = await loadShift(req, req.params.id);
    const totals = shift.status === 'closed' && shift.totals ? shift.totals : await computeShiftTotals(a.shopId!, shift);
    ok(res, { ...shift.toJSON(), totals });
  }),
);

async function reportContext(req: Request, terminalId: unknown, branchId: unknown) {
  const a = auth(req);
  const [terminal, branch] = await Promise.all([Terminal.findOne({ _id: terminalId, shopId: a.shopId }), Branch.findOne({ _id: branchId, shopId: a.shopId })]);
  return { shop: a.shop!, terminal, branch };
}

shiftsRouter.get(
  '/:id/x-report',
  idParams,
  requirePermission('reports.view', 'reports.own_shift', 'shifts.operate'),
  h(async (req, res) => {
    const a = auth(req);
    const shift = await loadShift(req, req.params.id);
    const totals = shift.status === 'closed' && shift.totals ? (shift.totals as any) : await computeShiftTotals(a.shopId!, shift);
    ok(res, { totals, report: buildShiftReport(shift.status === 'closed' ? 'z' : 'x', shift, totals, await reportContext(req, shift.terminalId, shift.branchId)) });
  }),
);

/**
 * Closing (spec 7.5): the cashier counts the drawer; expected cash = opening + cash sales -
 * cash refunds + cash in - cash out. The Z-report is frozen into the shift and, in fiscal
 * shops, the fiscal shift is closed in the module at the same time.
 */
shiftsRouter.post(
  '/:id/close',
  idParams,
  requirePermission('shifts.operate'),
  validate({ body: shiftCloseSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const shift = await loadShift(req, req.params.id);
    if (shift.status !== 'open') throw unprocessable('SHIFT_CLOSED');
    if (req.body.unsentOfflineCount > 0) throw unprocessable('UNSENT_SALES');

    const totals = await computeShiftTotals(a.shopId!, shift);
    const terminal = await Terminal.findOne({ _id: shift.terminalId, shopId: a.shopId });
    if (a.shop!.fiscalEnabled && terminal) {
      await runFiscal({ terminal, shop: a.shop!, docType: 'close_shift', docId: shift._id, fn: (p, ctx) => p.closeShift(ctx, shift.fiscalShiftId) });
    }
    const difference = req.body.countedCash - totals.expectedCash;
    const closed = await repo(req, Shift).findOneAndUpdate(
      { _id: shift._id, status: 'open' },
      { $set: { status: 'closed', closedAt: new Date(), closedBy: a.userId, countedCash: req.body.countedCash, expectedCash: totals.expectedCash, difference, totals, note: req.body.note } },
    );
    if (!closed) throw unprocessable('SHIFT_CLOSED');
    await audit(req, { action: 'shift.closed', entity: 'shift', entityId: shift._id, meta: { expectedCash: totals.expectedCash, countedCash: req.body.countedCash, difference } });
    events.emit({ name: 'shift.closed', shopId: a.shopId!, data: { id: String(shift._id), cashier: shift.cashierName, branchId: String(shift.branchId), expectedCash: totals.expectedCash, countedCash: req.body.countedCash, difference, receipts: totals.receipts } });
    ok(res, { shift: closed.toJSON(), report: buildShiftReport('z', closed, totals, await reportContext(req, closed.terminalId, closed.branchId)) });
  }),
);

/** Removals (line removed, cart cleared) are logged for the owner's staff-activity report. */
shiftsRouter.post(
  '/:id/removed-lines',
  idParams,
  requirePermission('sales.create'),
  validate({ body: removedLinesSchema }),
  h(async (req, res) => {
    const shift = await loadShift(req, req.params.id);
    await AuditLog.insertMany(
      req.body.items.map((i: any) => ({ shopId: shift.shopId, userId: auth(req).userId, userName: auth(req).user.fullName, role: auth(req).role, action: 'pos.line_removed', entity: 'shift', entityId: String(shift._id), meta: i, ip: req.ip })),
    );
    ok(res, { logged: req.body.items.length });
  }),
);

/* ===================================================================== cash operations */

export const cashOperationsRouter = Router();
cashOperationsRouter.use(authenticate);

cashOperationsRouter.post(
  '/',
  requirePermission('shifts.operate'),
  validate({ body: cashOperationSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const shift = await loadShift(req, req.body.shiftId);
    if (shift.status !== 'open') throw unprocessable('SHIFT_CLOSED');
    const op = await repo(req, CashOperation).create({ shiftId: shift._id, type: req.body.type, amount: req.body.amount, comment: req.body.comment, userId: a.userId });
    await audit(req, { action: `cash.${req.body.type}`, entity: 'shift', entityId: shift._id, meta: { amount: req.body.amount, comment: req.body.comment } });
    created(res, op.toJSON());
  }),
);

cashOperationsRouter.get(
  '/',
  requirePermission('shifts.operate', 'reports.view'),
  validate({ query: z.object({ shiftId: objectId }) }),
  h(async (req, res) => {
    const shift = await loadShift(req, (req.query as any).shiftId);
    const ops = await repo(req, CashOperation).find({ shiftId: shift._id }, { sort: 'createdAt' });
    ok(res, ops.map((o) => o.toJSON()));
  }),
);

/* ================================================================================ sales */

export const salesRouter = Router();
salesRouter.use(authenticate);

async function presentSale(req: Request, sale: SaleDoc, extra: Record<string, unknown> = {}, copy = false) {
  const a = auth(req);
  const [branch, terminal, customer] = await Promise.all([
    Branch.findOne({ _id: sale.branchId, shopId: a.shopId }),
    Terminal.findOne({ _id: sale.terminalId, shopId: a.shopId }),
    sale.customerId ? Customer.findOne({ _id: sale.customerId, shopId: a.shopId }) : null,
  ]);
  return { ...sale.toJSON(), receipt: buildSaleReceipt(sale, { shop: a.shop!, branch, terminal, customer, copy }), ...extra };
}

salesRouter.post(
  '/',
  requirePermission('sales.create'),
  validate({ body: saleInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = await createSale(a, req.body, { ip: req.ip });
    const body = await presentSale(req, r.sale, { warnings: r.warnings, duplicate: r.duplicate });
    res.status(r.duplicate ? 200 : 201).json({ data: body });
  }),
);

/** Offline batch: queued sales are applied in order, idempotently; one failure never blocks the rest. */
salesRouter.post(
  '/sync',
  requirePermission('sales.create'),
  validate({ body: salesSyncSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const results = [];
    for (const input of req.body.sales as z.infer<typeof saleInputSchema>[]) {
      try {
        const r = await createSale(a, { ...input, isOffline: true }, { ip: req.ip });
        results.push({ clientRequestId: input.clientRequestId, status: r.duplicate ? 'duplicate' : 'created', saleId: String(r.sale._id), number: r.sale.number, conflicts: r.sale.conflicts, warnings: r.warnings });
      } catch (e: any) {
        if (!(e instanceof AppError)) throw e;
        results.push({ clientRequestId: input.clientRequestId, status: 'error', error: { code: e.code, message: translate(req.lang, `errors.${e.code}`, e.params), details: e.details } });
      }
    }
    ok(res, results);
  }),
);

salesRouter.get(
  '/',
  requirePermission('reports.view', 'reports.own_shift'),
  validate({ query: saleListQuerySchema }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as unknown as z.infer<typeof saleListQuerySchema>;
    const filter: Record<string, any> = { ...branchScope(a) };
    if (a.role === 'cashier') filter.cashierId = a.userId;
    else if (q.cashierId) filter.cashierId = oid(q.cashierId);
    if (q.branchId) filter.branchId = oid(q.branchId);
    if (q.customerId) filter.customerId = oid(q.customerId);
    if (q.shiftId) filter.shiftId = oid(q.shiftId);
    if (q.productId) filter['lines.productId'] = oid(q.productId);
    if (q.number) filter.number = new RegExp('^' + escapeRegex(q.number));
    if (q.status) filter.status = q.status;
    if (q.offline) filter.isOffline = true;
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repo(req, Sale).paginate(filter, { page: q.page, limit: q.limit, sort: parseSort(q.sort, ['createdAt', 'total', 'number'], '-createdAt') });
    ok(res, items.map((s) => ({ ...s.toJSON(), lines: undefined, lineCount: s.lines.length })), meta);
  }),
);

async function getSale(req: Request, filter: Record<string, unknown>) {
  const a = auth(req);
  const sale = await repo(req, Sale).findOne(filter);
  if (!sale || !canAccessBranch(a, sale.branchId)) throw notFound('SALE_NOT_FOUND');
  return sale;
}

/** Find the original receipt for a return by its number (printed as a QR code on the receipt). */
salesRouter.get(
  '/by-number/:number',
  requirePermission('sales.create', 'reports.view', 'reports.own_shift'),
  h(async (req, res) => {
    const sale = await getSale(req, { number: String(req.params.number).trim() });
    ok(res, await presentSale(req, sale));
  }),
);

salesRouter.get(
  '/:id',
  idParams,
  requirePermission('sales.create', 'reports.view', 'reports.own_shift'),
  h(async (req, res) => ok(res, await presentSale(req, await getSale(req, { _id: req.params.id })))),
);

/** Reprint, marked "COPY". Cashiers: only receipts of their own open shift. */
salesRouter.get(
  '/:id/receipt',
  idParams,
  requirePermission('sales.create', 'reports.view'),
  h(async (req, res) => {
    const a = auth(req);
    const sale = await getSale(req, { _id: req.params.id });
    if (a.role === 'cashier') {
      const shift = await repo(req, Shift).findOne({ _id: sale.shiftId, status: 'open', cashierId: a.userId });
      if (!shift) throw forbidden();
    }
    await audit(req, { action: 'sale.reprinted', entity: 'sale', entityId: sale._id, meta: { number: sale.number } });
    ok(res, (await presentSale(req, sale, {}, true)).receipt);
  }),
);

/* ============================================================================== refunds */

export const refundsRouter = Router();
refundsRouter.use(authenticate);

refundsRouter.post(
  '/',
  requirePermission('sales.create', 'sales.refund'),
  validate({ body: refundInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = await createRefund(a, req.body, { ip: req.ip });
    const [branch, terminal, customer] = await Promise.all([
      Branch.findOne({ _id: r.refund.branchId, shopId: a.shopId }),
      Terminal.findOne({ _id: r.refund.terminalId, shopId: a.shopId }),
      r.sale.customerId ? Customer.findOne({ _id: r.sale.customerId, shopId: a.shopId }) : null,
    ]);
    res.status(r.duplicate ? 200 : 201).json({
      data: { ...r.refund.toJSON(), duplicate: r.duplicate, receipt: buildRefundReceipt(r.refund, r.sale, { shop: a.shop!, branch, terminal, customer, cashierName: a.user.fullName }) },
    });
  }),
);

refundsRouter.get(
  '/',
  requirePermission('reports.view', 'reports.own_shift'),
  validate({ query: paginationSchema.extend({ saleId: objectId.optional(), branchId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as any;
    const filter: Record<string, any> = { ...branchScope(a) };
    if (a.role === 'cashier') filter.cashierId = a.userId;
    if (q.saleId) filter.saleId = oid(q.saleId);
    if (q.branchId) filter.branchId = oid(q.branchId);
    if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const { items, meta } = await repo(req, Refund).paginate(filter, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((r) => r.toJSON()), meta);
  }),
);

refundsRouter.get(
  '/:id',
  idParams,
  requirePermission('reports.view', 'reports.own_shift'),
  h(async (req, res) => {
    const r = await repo(req, Refund).findById(req.params.id);
    if (!r || !canAccessBranch(auth(req), r.branchId)) throw notFound();
    ok(res, r.toJSON());
  }),
);

/* ===================================================================== POS support */

export const posRouter = Router();
posRouter.use(authenticate);

const SESSION_KEY_TTL_MS = 12 * 3600_000;

/** HMAC the agent can verify offline with the secret it received at pairing. */
export function signAgentSessionKey(secret: string, terminalId: string, expMs: number) {
  const mac = crypto.createHmac('sha256', secret).update(`${terminalId}.${expMs}`).digest('base64url');
  return `${expMs}.${mac}`;
}

posRouter.post(
  '/agent-session',
  requirePermission('sales.create', 'shifts.operate'),
  validate({ body: z.object({ terminalId: objectId }) }),
  h(async (req, res) => {
    const a = auth(req);
    const t = await repo(req, Terminal).findById(req.body.terminalId);
    if (!t || !canAccessBranch(a, t.branchId)) throw notFound('TERMINAL_NOT_FOUND');
    if (!t.agentTokenHash || !t.agentSecretEncrypted) throw unprocessable('TERMINAL_NOT_PAIRED');
    const exp = Date.now() + SESSION_KEY_TTL_MS;
    ok(res, { terminalId: String(t._id), sessionKey: signAgentSessionKey(decrypt(t.agentSecretEncrypted), String(t._id), exp), expiresAt: new Date(exp) });
  }),
);

/** Fallback path (spec 9.4): print jobs routed through the server to the agent. */
posRouter.post(
  '/print',
  requirePermission('sales.create', 'shifts.operate', 'products.view'),
  validate({ body: printJobSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const t = await repo(req, Terminal).findById(req.body.terminalId);
    if (!t || !canAccessBranch(a, t.branchId)) throw notFound('TERMINAL_NOT_FOUND');
    if (!t.agentTokenHash) throw unprocessable('TERMINAL_NOT_PAIRED');
    const reply = await agentHub.request(String(t._id), req.body.type, req.body.payload);
    ok(res, reply);
  }),
);

/** The POS reports how many offline receipts are still queued (shown on the owner's dashboard). */
posRouter.put(
  '/status',
  requirePermission('sales.create', 'shifts.operate'),
  validate({ body: z.object({ terminalId: objectId, pendingOffline: z.number().int().min(0).max(100000) }) }),
  h(async (req, res) => {
    const a = auth(req);
    const t = await repo(req, Terminal).findById(req.body.terminalId);
    if (!t || !canAccessBranch(a, t.branchId)) throw notFound('TERMINAL_NOT_FOUND');
    await repo(req, Terminal).updateOne({ _id: t._id }, { $set: { pendingOffline: req.body.pendingOffline, posOnlineAt: new Date() } });
    ok(res, { ok: true });
  }),
);

/** Cashiers of the terminal's branch, for the quick PIN switch on an authorised terminal. */
posRouter.get(
  '/cashiers',
  requirePermission('sales.create', 'shifts.operate'),
  validate({ query: z.object({ terminalId: objectId }) }),
  h(async (req, res) => {
    const a = auth(req);
    const t = await repo(req, Terminal).findById((req.query as any).terminalId);
    if (!t || !canAccessBranch(a, t.branchId)) throw notFound('TERMINAL_NOT_FOUND');
    const users = await repo(req, User).find({ isActive: true, pinHash: { $exists: true }, $or: [{ branchIds: t.branchId }, { role: 'shop_admin' }] }, { sort: 'fullName' });
    ok(res, users.map((u) => ({ id: String(u._id), login: u.login, fullName: u.fullName, role: u.role })));
  }),
);

/**
 * Branch catalog for the POS and its offline cache (spec 7.6). With `since` only changes are
 * returned; `removedPriceProductIds` tells the POS which prices were taken away. If `since` is
 * older than 7 days the client must do a full refresh.
 */
posRouter.get(
  '/catalog',
  requirePermission('sales.create', 'products.view'),
  validate({ query: z.object({ branchId: objectId.optional(), terminalId: objectId.optional(), since: z.coerce.date().optional() }) }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as any;
    let branchId = q.branchId as string | undefined;
    if (q.terminalId) {
      const t = await repo(req, Terminal).findById(q.terminalId);
      if (!t) throw notFound('TERMINAL_NOT_FOUND');
      branchId = String(t.branchId);
    }
    if (!branchId) branchId = a.branchIds[0] ? String(a.branchIds[0]) : undefined;
    if (!branchId || !canAccessBranch(a, branchId)) throw forbidden();
    const serverTime = new Date();
    const since: Date | undefined = q.since && serverTime.getTime() - new Date(q.since).getTime() < 7 * 86_400_000 ? q.since : undefined;

    const productFilter: Record<string, any> = since ? { updatedAt: { $gt: since } } : {};
    const [shop, branch, categories, products, prices, removed, promotions, customers] = await Promise.all([
      Shop.findById(a.shopId).lean(),
      repo(req, Branch).findById(branchId),
      repo(req, Category).find({}).lean(),
      repo(req, Product).find(productFilter).lean(),
      repo(req, Price).find({ branchId, ...(since ? { updatedAt: { $gt: since } } : {}) }).select('productId price').lean(),
      since ? repo(req, PriceChange).find({ branchId, status: 'applied', newPrice: null, createdAt: { $gt: since } }).select('productId').lean() : Promise.resolve([]),
      loadPromotionDefs(a.shopId!),
      repo(req, Customer).find(since ? { updatedAt: { $gt: since } } : {}, { sort: '-lastVisitAt' }).limit(since ? 5000 : 5000).lean(),
    ]);
    if (!branch) throw notFound('BRANCH_NOT_FOUND');
    const chain = new Map(categories.map((c) => [String(c._id), [String(c._id), ...(c.path ?? []).map(String)]]));
    ok(res, {
      serverTime,
      full: !since,
      shop: {
        name: shop!.name,
        currency: shop!.currency,
        fiscalEnabled: shop!.fiscalEnabled,
        settings: shop!.settings,
        logoUrl: shop!.logoUrl,
      },
      branch: { id: String(branch._id), name: branch.name, address: branch.address, phone: branch.phone, receiptHeader: branch.receiptHeader, receiptFooter: branch.receiptFooter },
      categories: categories.map((c) => ({ id: String(c._id), name: c.name, parentId: c.parentId ? String(c.parentId) : null, isActive: c.isActive, sortOrder: c.sortOrder })),
      products: products.map((p) => ({
        id: String(p._id),
        name: p.name,
        sku: p.sku,
        barcodes: p.barcodes,
        unit: p.unit,
        isWeighted: p.isWeighted,
        isMarked: p.isMarked,
        vatRate: p.vatRate,
        mxikCode: p.mxikCode,
        packageCode: p.packageCode,
        categoryId: p.categoryId ? String(p.categoryId) : null,
        categoryIds: p.categoryId ? (chain.get(String(p.categoryId)) ?? [String(p.categoryId)]) : [],
        imageUrl: p.imageUrl,
        isActive: p.isActive,
      })),
      prices: prices.map((p) => ({ productId: String(p.productId), price: p.price })),
      removedPriceProductIds: (removed as any[]).map((r) => String(r.productId)),
      promotions,
      customers: customers.map((c) => ({ id: String(c._id), fullName: c.fullName, phone: c.phone, cardBarcode: c.cardBarcode, bonusBalance: c.bonusBalance, debtBalance: c.debtBalance, creditLimit: c.creditLimit })),
    });
  }),
);

