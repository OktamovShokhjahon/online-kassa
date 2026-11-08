import type { Types } from 'mongoose';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { applyPromotions, isoDate, moneySchema, objectId, qtySchema, tashkentDateString, type CartLine } from '@kass/shared';
import { auditSystem } from '../../lib/audit';
import { runFiscal } from '../../lib/fiscal/service';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { events } from '../../lib/events';
import { created, h, ok } from '../../lib/http';
import { escapeRegex } from '../../lib/util';
import { validate } from '../../middleware/core';
import { Category, Price, Product } from '../../models/catalog';
import { Branch, Terminal, User } from '../../models/core';
import { Shift } from '../../models/sales';
import type { AuthContext } from '../../types';
import { authenticateApiKey } from '../developers/apiKeys';
import { buildSaleReceipt } from '../pos/receipt';
import { createSale, loadPromotionDefs } from '../pos/saleService';
import { buildShiftReport, computeShiftTotals } from '../pos/shiftService';

/**
 * API of the downloadable cash-desk program (Python, one terminal). It authenticates with a
 * program key created by the superadmin on the shop's Programs tab; the key is bound to one
 * terminal and the cashier whose name opens the shifts. Pricing, promotions, stock and fiscal
 * receipts all go through the same services as the web POS.
 */
export const deskRouter = Router();

const requireDeskKey: RequestHandler = (req, _res, next) => {
  if (req.apiKey?.program?.kind !== 'desk') return next(forbidden('PROGRAM_KEY_REQUIRED'));
  next();
};
deskRouter.use(authenticateApiKey, requireDeskKey);

interface Desk {
  shopId: Types.ObjectId;
  shop: NonNullable<Request['apiKey']>['shop'];
  terminal: any;
  branch: any;
  cashierId: Types.ObjectId;
}

async function desk(req: Request): Promise<Desk> {
  const k = req.apiKey!;
  const terminal = await Terminal.findOne({ _id: k.program!.terminalId, shopId: k.shopId });
  if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
  if (!terminal.isActive) throw unprocessable('TERMINAL_INACTIVE');
  const branch = await Branch.findOne({ _id: terminal.branchId, shopId: k.shopId });
  return { shopId: k.shopId, shop: k.shop, terminal, branch, cashierId: k.program!.cashierId };
}

/** The rights of a cashier at this terminal, the same the web POS has. */
function cashierCtx(d: Desk, cashierId: Types.ObjectId, fullName: string): AuthContext {
  return {
    kind: 'user',
    userId: cashierId,
    role: 'cashier',
    shopId: d.shopId,
    branchIds: [d.terminal.branchId],
    permissions: new Set(['sales.create', 'shifts.operate']),
    user: { fullName } as any,
    shop: d.shop,
    graceDaysLeft: null,
  } as unknown as AuthContext;
}

const presentProduct = (p: any, price: number | null) => ({
  id: String(p._id),
  name: p.name,
  barcodes: p.barcodes ?? [],
  sku: p.sku ?? null,
  unit: p.unit,
  isWeighted: !!p.isWeighted,
  isMarked: !!p.isMarked,
  price,
});

/**
 * Barcodes to try for a scanned string: the code itself and, for GS1 DataMatrix / QR marking
 * codes (`01` + GTIN-14 + serial...), the GTIN as GTIN-14 and EAN-13. The full code is the
 * marking code of that unit.
 */
export function codeCandidates(raw: string): { codes: string[]; markingCode?: string } {
  let code = raw.trim().replace(/\u0000/g, '');
  if (/^\][A-Za-z]\d/.test(code)) code = code.slice(3);
  code = code.replace(/^\u001d+/, '').trim();
  const codes = [code];
  let markingCode: string | undefined;
  const m = /^01(\d{14})/.exec(code);
  if (m) {
    codes.push(m[1], m[1].replace(/^0+/, ''), m[1].slice(1));
    if (code.length > 16) markingCode = code;
  } else if (/^0\d{13}$/.test(code)) codes.push(code.slice(1));
  else if (/^\d{12}$/.test(code)) codes.push('0' + code);
  return { codes: [...new Set(codes.filter(Boolean))], markingCode };
}

/** Server-side price + promotions for a cart, without saving anything (what the window shows). */
async function quote(d: Desk, lines: Array<{ productId: string; qty: number }>) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const [products, prices] = await Promise.all([
    Product.find({ shopId: d.shopId, _id: { $in: ids } }).lean(),
    Price.find({ shopId: d.shopId, branchId: d.terminal.branchId, productId: { $in: ids } }).lean(),
  ]);
  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const priceMap = new Map(prices.map((p) => [String(p.productId), p.price as number]));
  const items = lines.map((l, i) => {
    const product = pMap.get(l.productId);
    if (!product) throw notFound('PRODUCT_NOT_FOUND');
    const price = priceMap.get(l.productId);
    if (price === undefined) throw unprocessable('NO_PRICE', { name: product.name }, { productId: l.productId });
    return { i, product, qty: l.qty, price, gross: Math.round(l.qty * price) };
  });
  const promos = await loadPromotionDefs(d.shopId);
  let applied = new Map<string, { name: string; discount: number }>();
  if (promos.length) {
    const catIds = [...new Set(products.map((p) => p.categoryId).filter(Boolean).map(String))];
    const cats = catIds.length ? await Category.find({ shopId: d.shopId, _id: { $in: catIds } }).select('path').lean() : [];
    const chain = new Map(cats.map((c) => [String(c._id), [String(c._id), ...(c.path ?? []).map(String)]]));
    const cart: CartLine[] = items.map((it) => ({
      key: String(it.i),
      productId: String(it.product._id),
      categoryIds: it.product.categoryId ? (chain.get(String(it.product.categoryId)) ?? [String(it.product.categoryId)]) : [],
      qty: it.qty,
      price: it.price,
    }));
    applied = new Map(applyPromotions(cart, promos, String(d.terminal.branchId), new Date()).map((p) => [p.key, p]));
  }
  const out = items.map((it) => {
    const ap = applied.get(String(it.i));
    const discount = Math.min(ap?.discount ?? 0, it.gross);
    return { productId: String(it.product._id), qty: it.qty, price: it.price, gross: it.gross, discount, promotion: ap && discount ? ap.name : null, total: it.gross - discount };
  });
  const subtotal = out.reduce((s, l) => s + l.gross, 0);
  const total = out.reduce((s, l) => s + l.total, 0);
  return { lines: out, subtotal, discount: subtotal - total, total };
}

async function openShiftOf(d: Desk) {
  return Shift.findOne({ shopId: d.shopId, terminalId: d.terminal._id, status: 'open' });
}

/** Opens a shift on the program's terminal in the name of its cashier. */
async function openShift(d: Desk, openingCash: number, auto: boolean, ip?: string) {
  const cashier = await User.findOne({ _id: d.cashierId, shopId: d.shopId });
  if (!cashier || !cashier.isActive) throw notFound('CASHIER_NOT_FOUND');
  let shift;
  try {
    shift = await Shift.create({
      shopId: d.shopId,
      branchId: d.terminal.branchId,
      terminalId: d.terminal._id,
      cashierId: cashier._id,
      cashierName: cashier.fullName,
      openingCash,
      status: 'open',
      openedAt: new Date(),
      autoManaged: auto,
    });
  } catch (e: any) {
    if (e?.code === 11000) {
      // another sale of this terminal opened it a moment ago
      if (auto) return (await openShiftOf(d))!;
      throw unprocessable('SHIFT_ALREADY_OPEN');
    }
    throw e;
  }
  if (d.shop.fiscalEnabled) {
    try {
      const r = await runFiscal({ terminal: d.terminal, shop: d.shop, docType: 'open_shift', docId: shift._id, fn: (p, ctx) => p.openShift(ctx) });
      shift.fiscalShiftId = r.fiscalShiftId;
      await shift.save();
    } catch (e) {
      await Shift.deleteOne({ _id: shift._id, shopId: d.shopId });
      throw e;
    }
  }
  await auditSystem({ action: 'shift.opened', shopId: d.shopId, userId: cashier._id, entity: 'shift', entityId: shift._id, meta: { terminalId: String(d.terminal._id), openingCash, via: 'desk_program', auto }, ip });
  return shift;
}

/** Closes a shift and returns it with its Z-report data. `countedCash` null = the expected cash (no count). */
async function closeShift(d: Desk, shift: NonNullable<Awaited<ReturnType<typeof openShiftOf>>>, countedCash: number | null, note: string | undefined, ip?: string) {
  const totals = await computeShiftTotals(d.shopId, shift);
  if (d.shop.fiscalEnabled) {
    await runFiscal({ terminal: d.terminal, shop: d.shop, docType: 'close_shift', docId: shift._id, fn: (p, ctx) => p.closeShift(ctx, shift.fiscalShiftId) });
  }
  const counted = countedCash ?? totals.expectedCash;
  const difference = counted - totals.expectedCash;
  const closed = await Shift.findOneAndUpdate(
    { _id: shift._id, shopId: d.shopId, status: 'open' },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: shift.cashierId, countedCash: counted, expectedCash: totals.expectedCash, difference, totals, note } },
    { new: true },
  );
  if (!closed) return null; // closed meanwhile
  await auditSystem({ action: 'shift.closed', shopId: d.shopId, userId: shift.cashierId as Types.ObjectId, entity: 'shift', entityId: shift._id, meta: { expectedCash: totals.expectedCash, countedCash: counted, difference, via: 'desk_program', auto: countedCash === null }, ip });
  events.emit({ name: 'shift.closed', shopId: d.shopId, data: { id: String(shift._id), cashier: shift.cashierName, branchId: String(shift.branchId), expectedCash: totals.expectedCash, countedCash: counted, difference, receipts: totals.receipts } });
  return { closed, totals };
}

/**
 * The program has no shift buttons: its shifts run themselves. The first sale opens one, and a shift
 * the program opened on an earlier day (Tashkent time) is closed first, so every day is its own shift.
 * A shift opened by hand (web POS) on this terminal is used as it is and never closed here.
 */
async function ensureShift(d: Desk, create: boolean, ip?: string) {
  let shift = await openShiftOf(d);
  if (shift?.autoManaged && tashkentDateString(shift.openedAt) !== tashkentDateString(new Date())) {
    await closeShift(d, shift, null, 'closed automatically at the end of the day', ip);
    shift = null;
  }
  if (shift || !create) return shift;
  return openShift(d, 0, true, ip);
}

/* ===================================================================== session & catalog */

deskRouter.get(
  '/session',
  h(async (req, res) => {
    const d = await desk(req);
    const [shift, cashier] = await Promise.all([ensureShift(d, false, req.ip), User.findOne({ _id: d.cashierId, shopId: d.shopId }).select('fullName isActive').lean()]);
    ok(res, {
      shop: { name: d.shop.name, currency: d.shop.currency, fiscalEnabled: !!d.shop.fiscalEnabled, receiptLanguage: d.shop.settings?.receiptLanguage ?? 'uz' },
      branch: { id: String(d.branch?._id ?? d.terminal.branchId), name: d.branch?.name ?? '' },
      terminal: { id: String(d.terminal._id), name: d.terminal.name },
      cashier: cashier ? { id: String(cashier._id), fullName: cashier.fullName, isActive: cashier.isActive } : null,
      shift: shift ? { ...shift.toJSON(), totals: await computeShiftTotals(d.shopId, shift) } : null,
      serverTime: new Date(),
    });
  }),
);

/** Active products with this branch's price, cached by the program so scanning is instant. */
deskRouter.get(
  '/catalog',
  h(async (req, res) => {
    const d = await desk(req);
    const [products, prices] = await Promise.all([
      Product.find({ shopId: d.shopId, isActive: true }).select('name barcodes sku unit isWeighted isMarked').lean(),
      Price.find({ shopId: d.shopId, branchId: d.terminal.branchId }).select('productId price').lean(),
    ]);
    const priceMap = new Map(prices.map((p) => [String(p.productId), p.price as number]));
    ok(res, products.map((p) => presentProduct(p, priceMap.get(String(p._id)) ?? null)));
  }),
);

deskRouter.get(
  '/lookup',
  validate({ query: z.object({ code: z.string().trim().min(1).max(400) }) }),
  h(async (req, res) => {
    const d = await desk(req);
    const { codes, markingCode } = codeCandidates(String((req.query as any).code));
    const product =
      (await Product.findOne({ shopId: d.shopId, isActive: true, barcodes: { $in: codes } }).lean()) ??
      (await Product.findOne({ shopId: d.shopId, isActive: true, sku: new RegExp('^' + escapeRegex(codes[0]) + '$', 'i') }).lean());
    if (!product) throw notFound('PRODUCT_NOT_FOUND');
    const price = await Price.findOne({ shopId: d.shopId, branchId: d.terminal.branchId, productId: product._id }).lean();
    ok(res, { product: presentProduct(product, price?.price ?? null), markingCode: markingCode ?? null });
  }),
);

const linesSchema = z.array(z.object({ productId: objectId, qty: qtySchema })).min(1).max(300);

deskRouter.post(
  '/quote',
  validate({ body: z.object({ lines: linesSchema }) }),
  h(async (req, res) => {
    ok(res, await quote(await desk(req), req.body.lines));
  }),
);

/* ===================================================================================== sales */

const deskSaleSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(64),
  shiftId: objectId.optional(),
  lines: z
    .array(
      z.object({
        productId: objectId,
        qty: qtySchema,
        markingCode: z.string().trim().min(1).max(300).optional(),
        /** Offline sales only: the price the customer was charged. */
        price: moneySchema.optional(),
      }),
    )
    .min(1)
    .max(300),
  method: z.enum(['cash', 'card']),
  /** Cash handed over by the customer; change is given from it. */
  cashGiven: moneySchema.optional(),
  isOffline: z.boolean().default(false),
  createdAt: isoDate.optional(),
  localNumber: z.string().trim().max(40).optional(),
});

/**
 * One receipt. The total is computed on the server (prices + promotions), the payment is then
 * the whole total by card, or the cash given (change = given - total). Offline sales keep the
 * prices the program charged, like offline sales of the web POS.
 */
deskRouter.post(
  '/sales',
  validate({ body: deskSaleSchema }),
  h(async (req, res) => {
    const d = await desk(req);
    const b = req.body as z.infer<typeof deskSaleSchema>;
    // an older program copy may name its shift; otherwise (and when that shift is closed) the server picks or opens one
    const named = b.shiftId ? await Shift.findOne({ _id: b.shiftId, shopId: d.shopId, terminalId: d.terminal._id, status: 'open' }) : null;
    const shift = named ?? (await ensureShift(d, true, req.ip));
    if (!shift) throw notFound('SHIFT_NOT_FOUND');

    let total: number;
    if (b.isOffline) {
      if (b.lines.some((l) => l.price === undefined)) throw unprocessable('VALIDATION_ERROR');
      total = b.lines.reduce((s, l) => s + Math.round(l.qty * l.price!), 0);
    } else {
      total = (await quote(d, b.lines)).total;
    }
    const given = b.method === 'cash' ? (b.cashGiven ?? total) : 0;
    if (b.method === 'cash' && given < total) throw unprocessable('PAYMENT_INSUFFICIENT');
    const payments = b.method === 'card' ? [{ method: 'card' as const, amount: total }] : [{ method: 'cash' as const, amount: given }];

    const ctx = cashierCtx(d, shift.cashierId as Types.ObjectId, shift.cashierName ?? '');
    const r = await createSale(
      ctx,
      {
        clientRequestId: b.clientRequestId,
        terminalId: String(d.terminal._id),
        shiftId: String(shift._id),
        lines: b.lines.map((l) => ({ productId: l.productId, qty: l.qty, markingCode: l.markingCode, discount: 0, ...(b.isOffline ? { price: l.price } : {}) })),
        discount: 0,
        payments,
        isOffline: b.isOffline,
        createdAt: b.isOffline ? b.createdAt : undefined,
        localNumber: b.localNumber,
      } as any,
      { ip: req.ip },
    );
    const s = r.sale;
    res.status(r.duplicate ? 200 : 201).json({
      data: {
        sale: { id: String(s._id), number: s.number, total: s.total, discount: s.discount, cashGiven: s.cashGiven, change: s.change, isOffline: s.isOffline },
        receipt: buildSaleReceipt(s, { shop: d.shop, branch: d.branch, terminal: d.terminal }),
        duplicate: r.duplicate,
        warnings: r.warnings,
      },
    });
  }),
);

/* ===================================================================================== shift */

deskRouter.post(
  '/shift/open',
  validate({ body: z.object({ openingCash: moneySchema.default(0) }) }),
  h(async (req, res) => {
    const shift = await openShift(await desk(req), req.body.openingCash, false, req.ip);
    created(res, shift.toJSON());
  }),
);

deskRouter.get(
  '/shift/x-report',
  h(async (req, res) => {
    const d = await desk(req);
    const shift = await openShiftOf(d);
    if (!shift) throw notFound('SHIFT_NOT_FOUND');
    const totals = await computeShiftTotals(d.shopId, shift);
    ok(res, { totals, report: buildShiftReport('x', shift, totals, { shop: d.shop, branch: d.branch, terminal: d.terminal }) });
  }),
);

deskRouter.post(
  '/shift/close',
  validate({ body: z.object({ countedCash: moneySchema, note: z.string().trim().max(300).optional() }) }),
  h(async (req, res) => {
    const d = await desk(req);
    const shift = await openShiftOf(d);
    if (!shift) throw notFound('SHIFT_NOT_FOUND');
    const r = await closeShift(d, shift, req.body.countedCash, req.body.note, req.ip);
    if (!r) throw unprocessable('SHIFT_CLOSED');
    ok(res, { shift: r.closed.toJSON(), report: buildShiftReport('z', r.closed, r.totals, { shop: d.shop, branch: d.branch, terminal: d.terminal }) });
  }),
);
