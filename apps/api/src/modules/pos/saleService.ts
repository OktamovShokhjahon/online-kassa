import mongoose, { type Types } from 'mongoose';
import {
  applyPromotions,
  inventoryEnabled,
  type CartLine,
  type PromotionDef,
  type SaleInput,
} from '@kass/shared';
import { withTx } from '../../db/connect';
import { auditSystem } from '../../lib/audit';
import { nextSeq } from '../../lib/counters';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors';
import { events, type DomainEvent } from '../../lib/events';
import { logger } from '../../lib/logger';
import { fiscalContext, getProvider, runFiscal } from '../../lib/fiscal/service';
import { oid } from '../../lib/util';
import { can, canAccessBranch } from '../../middleware/auth';
import { Category, Price, Product } from '../../models/catalog';
import { Branch, Terminal, User } from '../../models/core';
import { BonusTransaction, Customer, Promotion, Sale, Shift, type CustomerDoc, type SaleDoc } from '../../models/sales';
import { StockTx, lockCurrency } from '../stock/stockService';
import type { AuthContext } from '../../types';
import { verifyApproval } from './approval';

export interface SaleWarning {
  type: 'negative_stock';
  productId: string;
  name: string;
  balance: number;
}
export interface SaleResult {
  sale: SaleDoc;
  duplicate: boolean;
  warnings: SaleWarning[];
}

const EPS = 1e-9;

/** `<branchCode>-<sequence>`; the branch code is assigned lazily so old branches keep working. */
export async function ensureBranchCode(shopId: Types.ObjectId, branchId: Types.ObjectId): Promise<number> {
  const b = await Branch.findOne({ _id: branchId, shopId }).select('code').lean();
  if (b?.code) return b.code;
  const code = await nextSeq(shopId, 'branchCode');
  const updated = await Branch.findOneAndUpdate({ _id: branchId, shopId, code: { $exists: false } }, { $set: { code } }, { new: true });
  return updated?.code ?? (await Branch.findOne({ _id: branchId, shopId }).select('code').lean())!.code!;
}

export async function loadPromotionDefs(shopId: Types.ObjectId): Promise<PromotionDef[]> {
  const rows = await Promotion.find({ shopId, isActive: true }).lean();
  return rows.map((p) => ({
    id: String(p._id),
    name: p.name,
    type: p.type as PromotionDef['type'],
    priority: p.priority ?? 0,
    allowStack: !!p.allowStack,
    isActive: p.isActive,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    branchIds: (p.branchIds ?? []).map(String),
    schedule: p.schedule as any,
    rules: { ...(p.rules as any) },
  }));
}

/**
 * Creates one receipt (spec 7.2). Order of work:
 *  1. idempotency check on `clientRequestId`
 *  2. authoritative pricing + promotions + discount rules + payment rules (no writes yet)
 *  3. fiscalization (fiscal shops) - the sale is not completed if the module does not answer
 *  4. ONE transaction: stock, sale, customer bonus/debt, currency lock
 * Offline sales keep the price and promotion actually charged; differences are recorded as conflicts.
 */
export async function createSale(a: AuthContext, input: SaleInput, opts: { ip?: string } = {}): Promise<SaleResult> {
  const shopId = a.shopId!;
  const shop = a.shop!;
  const isOffline = input.isOffline;
  const now = new Date();
  const soldAt = isOffline && input.createdAt ? input.createdAt : now;

  // 1. idempotency
  const existing = await Sale.findOne({ shopId, clientRequestId: input.clientRequestId });
  if (existing) return { sale: existing, duplicate: true, warnings: [] };

  // 2a. terminal / shift
  const terminal = await Terminal.findOne({ _id: input.terminalId, shopId });
  if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
  if (!terminal.isActive) throw unprocessable('TERMINAL_INACTIVE');
  if (!canAccessBranch(a, terminal.branchId)) throw forbidden('TERMINAL_BRANCH_MISMATCH');
  const shift = await Shift.findOne({ _id: input.shiftId, shopId, terminalId: terminal._id });
  if (!shift) throw notFound('SHIFT_NOT_FOUND');
  if (shift.status !== 'open') throw unprocessable('SHIFT_CLOSED');
  if (a.role === 'cashier' && String(shift.cashierId) !== String(a.userId)) throw forbidden('SHIFT_OWNER_ONLY');
  const branchId = terminal.branchId as Types.ObjectId;

  // 2b. products and prices
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const [products, prices] = await Promise.all([
    Product.find({ shopId, _id: { $in: productIds } }).lean(),
    Price.find({ shopId, branchId, productId: { $in: productIds } }).lean(),
  ]);
  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const priceMap = new Map(prices.map((p) => [String(p.productId), p.price as number]));
  if (pMap.size !== productIds.length) throw notFound('PRODUCT_NOT_FOUND');

  const conflicts: Array<Record<string, unknown>> = [];
  const items = input.lines.map((l, i) => {
    const product = pMap.get(l.productId)!;
    if (!isOffline && !product.isActive) throw unprocessable('PRODUCT_INACTIVE', undefined, { productId: l.productId });
    const dbPrice = priceMap.get(l.productId);
    let price: number;
    if (isOffline && l.price !== undefined) {
      price = l.price; // the price actually charged
      if (dbPrice === undefined) conflicts.push({ kind: 'price_removed', productId: l.productId, charged: price });
      else if (dbPrice !== price) conflicts.push({ kind: 'price_changed', productId: l.productId, charged: price, current: dbPrice });
    } else {
      if (dbPrice === undefined) throw unprocessable('NO_PRICE', undefined, { productId: l.productId, name: product.name });
      price = dbPrice;
    }
    if (product.isMarked && (!l.markingCode || Math.abs(l.qty - 1) > EPS)) throw unprocessable('MARKING_CODE_REQUIRED', undefined, { productId: l.productId });
    return { i, input: l, product, price, gross: Math.round(l.qty * price) };
  });

  // 2c. fiscal prerequisites
  const fiscal = shop.fiscalEnabled;
  if (fiscal) {
    const provider = getProvider(terminal);
    if (isOffline && !provider.supportsOffline) throw unprocessable('OFFLINE_NOT_ALLOWED');
    for (const it of items) {
      if (!it.product.mxikCode || !it.product.packageCode) throw unprocessable('FISCAL_MISSING_CODES', undefined, { productId: String(it.product._id), name: it.product.name });
    }
  }

  // 2d. promotions (server is authoritative online; offline keeps what the POS applied)
  const promos = isOffline ? [] : await loadPromotionDefs(shopId);
  const promoMeta = new Map(promos.map((p) => [p.id, p]));
  let applied = new Map<string, { promotionId: string; name: string; discount: number; allowStack: boolean }>();
  if (!isOffline && promos.length) {
    const catIds = [...new Set(products.map((p) => p.categoryId).filter(Boolean).map(String))];
    const cats = catIds.length ? await Category.find({ shopId, _id: { $in: catIds } }).select('path').lean() : [];
    const catChain = new Map(cats.map((c) => [String(c._id), [String(c._id), ...(c.path ?? []).map(String)]]));
    const cart: CartLine[] = items.map((it) => ({
      key: String(it.i),
      productId: String(it.product._id),
      categoryIds: it.product.categoryId ? (catChain.get(String(it.product.categoryId)) ?? [String(it.product.categoryId)]) : [],
      qty: it.input.qty,
      price: it.price,
    }));
    applied = new Map(applyPromotions(cart, promos, String(branchId), soldAt).map((p) => [p.key, p]));
  }

  // 2e. line discounts
  let lineNetBeforeReceipt = 0;
  const rows = items.map((it) => {
    let promoDiscount = 0;
    let promotionId: Types.ObjectId | undefined;
    let promotionName: string | undefined;
    let allowStack = true;
    if (isOffline) {
      promoDiscount = it.input.promoDiscount ?? 0;
      if (promoDiscount > 0 && it.input.promotionId) {
        promotionId = oid(it.input.promotionId);
        allowStack = false;
      }
    } else {
      const ap = applied.get(String(it.i));
      if (ap) {
        promoDiscount = ap.discount;
        promotionId = oid(ap.promotionId);
        promotionName = ap.name;
        allowStack = promoMeta.get(ap.promotionId)?.allowStack ?? false;
      }
    }
    const manual = it.input.discount ?? 0;
    if (promoDiscount > 0 && !allowStack && manual > 0) throw unprocessable('PROMOTION_STACK');
    if (promoDiscount + manual > it.gross) throw unprocessable('DISCOUNT_TOO_LARGE');
    const net = it.gross - promoDiscount - manual;
    lineNetBeforeReceipt += net;
    return { ...it, promoDiscount, manual, promotionId, promotionName, stackable: promoDiscount === 0 || allowStack, net, share: 0 };
  });

  // receipt-level manual discount, spread proportionally over lines that may take it
  const receiptDiscount = input.discount ?? 0;
  if (receiptDiscount > 0) {
    const stackable = rows.filter((r) => r.stackable && r.net > 0);
    const base = stackable.reduce((s, r) => s + r.net, 0);
    if (!stackable.length) throw unprocessable('PROMOTION_STACK');
    if (receiptDiscount > base) throw unprocessable('DISCOUNT_TOO_LARGE');
    let left = receiptDiscount;
    stackable.forEach((r, idx) => {
      const share = idx === stackable.length - 1 ? left : Math.min(r.net, Math.round((receiptDiscount * r.net) / base));
      r.share = share;
      left -= share;
    });
  }
  const lineTotals = rows.map((r) => r.net - r.share);
  const subtotal = rows.reduce((s, r) => s + r.gross, 0);
  const promoTotal = rows.reduce((s, r) => s + r.promoDiscount, 0);
  const manualTotal = rows.reduce((s, r) => s + r.manual, 0) + receiptDiscount;
  const total = lineTotals.reduce((s, t) => s + t, 0);
  if (total <= 0) throw badRequest('VALIDATION_ERROR', [{ path: 'lines', message: 'Receipt total must be positive' }]);

  // 2f. manual discount above the cashier's limit needs a manager's approval
  let approvedBy: Types.ObjectId | undefined;
  const discountBase = subtotal - promoTotal;
  if (manualTotal > 0 && discountBase > 0 && !can(a, 'sales.discount')) {
    const pct = (manualTotal / discountBase) * 100;
    if (pct > (shop.settings?.maxCashierDiscount ?? 0) + EPS) {
      if (!input.approval) throw forbidden('DISCOUNT_APPROVAL_REQUIRED');
      approvedBy = (await verifyApproval(a, branchId, input.approval, 'sales.discount'))._id;
    }
  }

  // 2g. customer, payments
  let customer: CustomerDoc | null = null;
  if (input.customerId) {
    customer = await Customer.findOne({ _id: input.customerId, shopId });
    if (!customer) throw notFound('CUSTOMER_NOT_FOUND');
  }
  const paid = { cash: 0, card: 0, bonus: 0, credit: 0 };
  for (const p of input.payments) paid[p.method] += p.amount;
  if ((paid.bonus || paid.credit) && !customer) throw badRequest('CUSTOMER_REQUIRED');
  if ((paid.bonus || paid.credit) && isOffline) throw unprocessable('OFFLINE_NOT_ALLOWED');
  if (paid.credit && !can(a, 'sales.credit')) throw forbidden('SALE_CREDIT_FORBIDDEN');
  if (paid.bonus) {
    const maxPct = shop.settings?.loyalty?.maxPayPercent ?? 0;
    if (paid.bonus > customer!.bonusBalance || paid.bonus > Math.floor((total * maxPct) / 100)) throw unprocessable('BONUS_INSUFFICIENT');
  }
  if (paid.credit && customer!.creditLimit !== null && customer!.creditLimit !== undefined && customer!.debtBalance + paid.credit > customer!.creditLimit) {
    throw unprocessable('CREDIT_LIMIT');
  }
  const nonCash = paid.card + paid.bonus + paid.credit;
  const cashDue = total - nonCash;
  if (cashDue < 0) throw unprocessable('PAYMENT_MISMATCH');
  if (cashDue === 0 && paid.cash > 0) throw unprocessable('PAYMENT_MISMATCH');
  if (paid.cash < cashDue) throw unprocessable('PAYMENT_INSUFFICIENT');
  const change = paid.cash - cashDue;
  const payments = (['cash', 'card', 'bonus', 'credit'] as const)
    .map((method) => ({ method, amount: method === 'cash' ? cashDue : paid[method] }))
    .filter((p) => p.amount > 0);
  const bonusPct = shop.settings?.loyalty?.bonusPercent ?? 0;
  const bonusEarned = customer && bonusPct > 0 ? Math.round(((cashDue + paid.card) * bonusPct) / 100) : 0;

  const cashier = await User.findOne({ _id: shift.cashierId, shopId }).select('fullName').lean();
  const lines = rows.map((r, idx) => ({
    productId: r.product._id,
    name: r.product.name,
    barcode: r.product.barcodes?.[0],
    markingCode: r.input.markingCode,
    unit: r.product.unit,
    qty: r.input.qty,
    price: r.price,
    promotionId: r.promotionId,
    promotionName: r.promotionName,
    promoDiscount: r.promoDiscount,
    manualDiscount: r.manual,
    receiptDiscountShare: r.share,
    total: lineTotals[idx],
    unitCost: 0,
    vatRate: r.product.vatRate ?? undefined,
    mxikCode: r.product.mxikCode ?? undefined,
    packageCode: r.product.packageCode ?? undefined,
    refundedQty: 0,
    refundedAmount: 0,
  }));

  // 3. fiscalization BEFORE the sale is saved: no fiscal receipt -> no sale (spec 8.6)
  let fiscalData: SaleDoc['fiscal'] | undefined;
  if (fiscal) {
    const fres = await runFiscal({
      terminal,
      shop,
      docType: 'sale',
      request: { clientRequestId: input.clientRequestId, total, lines: lines.length },
      fn: (provider, ctx) =>
        provider.registerSale(ctx, {
          number: input.clientRequestId,
          createdAt: soldAt,
          isOffline,
          total,
          payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
          lines: lines.map((l) => ({
            name: l.name ?? '',
            qty: l.qty,
            price: Math.round(l.total / l.qty),
            total: l.total,
            vatRate: l.vatRate ?? null,
            mxikCode: l.mxikCode ?? null,
            packageCode: l.packageCode ?? null,
            markingCode: l.markingCode ?? null,
          })),
        }),
    });
    fiscalData = { status: 'registered', sign: fres.sign, receiptId: fres.receiptId, qr: fres.qr, moduleId: fres.moduleId };
  }

  // 4. one transaction
  const warnings: SaleWarning[] = [];
  let stockEvents: DomainEvent[] = [];
  let sale: SaleDoc;
  try {
    const code = await ensureBranchCode(shopId, branchId);
    sale = await withTx(async (session) => {
      warnings.length = 0;
      const tx = await StockTx.forShop(shopId, session, a.userId);
      const seq = await nextSeq(shopId, `sale:${branchId}`, session);
      const saleNumber = `${code}-${String(seq).padStart(6, '0')}`;
      const saleId = new mongoose.Types.ObjectId();

      for (const l of lines) {
        const r = await tx.move({ branchId, productId: l.productId, type: 'sale', quantity: -l.qty, docType: 'sale', docId: saleId, docNumber: saleNumber });
        // cost of the sale: the product's cost price while the warehouse is off (or when no receipt gave an average cost)
        const costPrice = pMap.get(String(l.productId))?.costPrice;
        l.unitCost = !inventoryEnabled() && costPrice != null ? costPrice : r.avgCost || costPrice || 0;
        if (r.negative) {
          (l as any).negativeStock = true;
          warnings.push({ type: 'negative_stock', productId: String(l.productId), name: l.name ?? '', balance: r.balanceAfter });
        }
      }

      const [created] = await Sale.create(
        [
          {
            _id: saleId,
            shopId,
            branchId,
            terminalId: terminal._id,
            shiftId: shift._id,
            cashierId: shift.cashierId,
            cashierName: cashier?.fullName,
            customerId: customer?._id,
            number: saleNumber,
            localNumber: input.localNumber,
            lines,
            subtotal,
            discount: promoTotal + manualTotal,
            receiptDiscount,
            total,
            payments,
            cashGiven: paid.cash,
            change,
            bonusEarned,
            bonusSpent: paid.bonus,
            currency: shop.currency,
            fiscal: fiscalData,
            isOffline,
            syncedAt: isOffline ? now : undefined,
            conflicts,
            clientRequestId: input.clientRequestId,
            status: 'completed',
            approvedBy,
            createdAt: soldAt,
          },
        ],
        { session },
      );

      if (customer) {
        const net = bonusEarned - paid.bonus;
        const upd = await Customer.findOneAndUpdate(
          { _id: customer._id, shopId, ...(paid.bonus ? { bonusBalance: { $gte: paid.bonus } } : {}) },
          {
            $inc: { bonusBalance: net, debtBalance: paid.credit, totalSpent: total, receiptCount: 1 },
            $set: { lastVisitAt: soldAt, ...(paid.credit && customer.debtBalance <= 0 ? { debtSince: soldAt } : {}) },
          },
          { new: true, session },
        );
        if (!upd) throw unprocessable('BONUS_INSUFFICIENT');
        const tx2 = [];
        if (paid.bonus) tx2.push({ shopId, customerId: customer._id, saleId, type: 'spend', amount: -paid.bonus, balanceAfter: upd.bonusBalance - bonusEarned });
        if (bonusEarned) tx2.push({ shopId, customerId: customer._id, saleId, type: 'earn', amount: bonusEarned, balanceAfter: upd.bonusBalance });
        if (tx2.length) await BonusTransaction.create(tx2, { session, ordered: true });
      }
      await lockCurrency(shopId, session);
      stockEvents = tx.events;
      return created as SaleDoc;
    });
  } catch (err: any) {
    // lost a race against the same clientRequestId: return the winner
    if (err?.code === 11000 && /clientRequestId/.test(String(err.message))) {
      const winner = await Sale.findOne({ shopId, clientRequestId: input.clientRequestId });
      if (winner) return { sale: winner, duplicate: true, warnings: [] };
    }
    // The fiscal receipt exists but the sale could not be saved: reverse it so the books stay clean.
    if (fiscal && fiscalData?.receiptId) {
      logger.error('sale failed after fiscalization; registering fiscal reversal', { shopId: String(shopId), receiptId: fiscalData.receiptId, err: String(err?.message ?? err) });
      runFiscal({
        terminal, shop, docType: 'refund',
        request: { reason: 'sale_failed_after_fiscalization', receiptId: fiscalData.receiptId },
        fn: (provider, ctx) => provider.registerRefund(ctx, { number: `${input.clientRequestId}-rollback`, createdAt: new Date(), total, payments: [], lines: [], refundOfReceiptId: fiscalData!.receiptId! }),
      }).catch(() => undefined);
    }
    throw err;
  }

  if (approvedBy) await auditApproval(a, sale, approvedBy, opts.ip);
  events.emitAll([...stockEvents, { name: 'sale.created', shopId, data: { id: String(sale._id), number: sale.number, total: sale.total, branchId: String(branchId), cashierId: String(sale.cashierId), isOffline } }]);
  return { sale, duplicate: false, warnings };
}

async function auditApproval(a: AuthContext, sale: SaleDoc, approver: Types.ObjectId, ip?: string) {
  await auditSystem({ action: 'sale.discount_approved', shopId: a.shopId, userId: a.userId, entity: 'sale', entityId: sale._id, meta: { approvedBy: String(approver), discount: sale.discount, total: sale.total }, ip });
}

