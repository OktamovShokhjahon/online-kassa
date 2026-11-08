import mongoose, { type Types } from 'mongoose';
import type { z } from 'zod';
import type { refundInputSchema } from '@kass/shared';
import { withTx } from '../../db/connect';
import { auditSystem } from '../../lib/audit';
import { nextSeq } from '../../lib/counters';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { events, type DomainEvent } from '../../lib/events';
import { runFiscal } from '../../lib/fiscal/service';
import { can, canAccessBranch } from '../../middleware/auth';
import { Terminal } from '../../models/core';
import { BonusTransaction, Customer, Refund, Sale, Shift, type RefundDoc, type SaleDoc } from '../../models/sales';
import { StockTx } from '../stock/stockService';
import type { AuthContext } from '../../types';
import { verifyApproval } from './approval';

const EPS = 1e-9;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface RefundResult {
  refund: RefundDoc;
  sale: SaleDoc;
  duplicate: boolean;
}

/** Resolves requested lines against the sale: returns [saleLineIndex, qty, amount]. */
function planLines(sale: SaleDoc, requested: z.infer<typeof refundInputSchema>['lines']) {
  const takenFromLine = new Map<number, number>();
  const plan: Array<{ index: number; qty: number; amount: number }> = [];
  for (const r of requested) {
    let index = r.lineIndex;
    if (index === undefined) {
      index = sale.lines.findIndex((l, i) => String(l.productId) === r.productId && l.qty - l.refundedQty - (takenFromLine.get(i) ?? 0) > EPS);
      if (index < 0) index = sale.lines.findIndex((l) => String(l.productId) === r.productId);
    }
    const line = index >= 0 ? sale.lines[index] : undefined;
    if (!line || String(line.productId) !== r.productId) throw notFound('PRODUCT_NOT_FOUND');
    const already = takenFromLine.get(index) ?? 0;
    const remaining = round3(line.qty - line.refundedQty - already);
    if (r.qty > remaining + EPS) throw unprocessable('REFUND_EXCEEDS_SOLD', undefined, { productId: r.productId, remaining });
    const isLast = Math.abs(r.qty - remaining) < EPS;
    // the final unit takes whatever is left of the line total, so rounding never loses a tiyin
    const amount = isLast ? line.total - line.refundedAmount - plan.filter((p) => p.index === index).reduce((s, p) => s + p.amount, 0) : Math.round((line.total * r.qty) / line.qty);
    takenFromLine.set(index, already + r.qty);
    plan.push({ index, qty: r.qty, amount });
  }
  return plan;
}

/**
 * Customer return (spec 7.4): partial returns, never more than sold minus earlier returns.
 * Allowed with `sales.refund` or a manager's PIN. Stock goes back (or to write-off), loyalty
 * and debts are reversed, and fiscal shops register a linked refund receipt.
 */
export async function createRefund(a: AuthContext, input: z.infer<typeof refundInputSchema>, opts: { ip?: string } = {}): Promise<RefundResult> {
  const shopId = a.shopId!;
  const shop = a.shop!;

  if (input.clientRequestId) {
    const dup = await Refund.findOne({ shopId, clientRequestId: input.clientRequestId });
    if (dup) return { refund: dup, sale: (await Sale.findOne({ _id: dup.saleId, shopId }))!, duplicate: true };
  }
  const sale0 = await Sale.findOne({ _id: input.saleId, shopId });
  if (!sale0) throw notFound('SALE_NOT_FOUND');
  if (!canAccessBranch(a, sale0.branchId)) throw notFound('SALE_NOT_FOUND');

  // right to refund: permission or manager PIN
  let approvedBy: Types.ObjectId | undefined;
  if (!can(a, 'sales.refund')) {
    approvedBy = (await verifyApproval(a, sale0.branchId, input.approval, 'sales.refund'))._id;
  }
  // cash leaves the drawer of the refunding cashier's open shift
  const shift = await Shift.findOne({ shopId, cashierId: a.userId, status: 'open' });
  if (!shift) throw unprocessable('NO_OPEN_SHIFT');
  if (String(shift.branchId) !== String(sale0.branchId)) throw forbidden('TERMINAL_BRANCH_MISMATCH');
  const terminal = await Terminal.findOne({ _id: shift.terminalId, shopId });

  planLines(sale0, input.lines); // fail fast before touching the fiscal module

  // fiscal refund first (linked to the original fiscal receipt)
  let fiscal: RefundDoc['fiscal'] | undefined;
  const preTotal = planLines(sale0, input.lines).reduce((s, p) => s + p.amount, 0);
  if (shop.fiscalEnabled) {
    if (!sale0.fiscal?.receiptId || !terminal) throw unprocessable('FISCAL_NOT_CONFIGURED');
    const plan0 = planLines(sale0, input.lines);
    const f = await runFiscal({
      terminal,
      shop,
      docType: 'refund',
      docId: sale0._id,
      request: { saleNumber: sale0.number, total: preTotal },
      fn: (provider, ctx) =>
        provider.registerRefund(ctx, {
          number: input.clientRequestId ?? `${sale0.number}-R${Date.now()}`,
          createdAt: new Date(),
          total: preTotal,
          payments: [{ method: input.method, amount: preTotal }],
          refundOfReceiptId: sale0.fiscal!.receiptId!,
          lines: plan0.map((p) => ({ name: sale0.lines[p.index].name ?? '', qty: p.qty, price: Math.round(p.amount / p.qty), total: p.amount, vatRate: sale0.lines[p.index].vatRate ?? null, mxikCode: sale0.lines[p.index].mxikCode ?? null, packageCode: sale0.lines[p.index].packageCode ?? null })),
        }),
    });
    fiscal = { status: 'registered', sign: f.sign, receiptId: f.receiptId, qr: f.qr, moduleId: f.moduleId };
  }

  let stockEvents: DomainEvent[] = [];
  const result = await withTx(async (session) => {
    // re-read inside the transaction: two cashiers refunding the same receipt cannot over-refund
    const sale = await Sale.findOne({ _id: input.saleId, shopId }).session(session);
    if (!sale) throw notFound('SALE_NOT_FOUND');
    const plan = planLines(sale, input.lines);
    const total = plan.reduce((s, p) => s + p.amount, 0);
    if (total <= 0) throw unprocessable('REFUND_EXCEEDS_SOLD');

    const creditPaid = sale.payments.find((p) => p.method === 'credit')?.amount ?? 0;
    let customer = sale.customerId ? await Customer.findOne({ _id: sale.customerId, shopId }).session(session) : null;
    const bonusRestored = sale.total ? Math.min(sale.bonusSpent, Math.round((total * sale.bonusSpent) / sale.total)) : 0;
    let creditOffset = sale.total ? Math.round((total * creditPaid) / sale.total) : 0;
    if (customer) creditOffset = Math.min(creditOffset, Math.max(0, customer.debtBalance));
    const priorReversed = (await Refund.find({ shopId, saleId: sale._id }).session(session).select('bonusReversed').lean()).reduce((s, r) => s + (r.bonusReversed ?? 0), 0);
    const bonusReversed = sale.total ? Math.max(0, Math.min(sale.bonusEarned - priorReversed, Math.round((total * sale.bonusEarned) / sale.total))) : 0;
    const payout = total - bonusRestored - creditOffset;
    let debtReduced = creditOffset;
    if (input.method === 'debt') {
      if (!customer) throw unprocessable('REFUND_METHOD_INVALID');
      if (payout > customer.debtBalance - creditOffset) throw unprocessable('DEBT_EXCEEDS');
      debtReduced += payout; // the money part reduces what the customer owes
    }

    const tx = await StockTx.forShop(shopId, session, a.userId);
    const refundId = new mongoose.Types.ObjectId();
    const seq = await nextSeq(shopId, 'refund', session);
    const number = `R-${String(seq).padStart(6, '0')}`;
    for (const p of plan) {
      const line = sale.lines[p.index];
      await tx.move({ branchId: sale.branchId, productId: line.productId, type: 'customer_return', quantity: p.qty, unitCost: line.unitCost, docType: 'refund', docId: refundId, docNumber: number });
      if (input.restock === 'writeoff') {
        await tx.move({ branchId: sale.branchId, productId: line.productId, type: 'write_off', quantity: -p.qty, unitCost: line.unitCost, docType: 'refund', docId: refundId, docNumber: number, note: 'damaged return' });
      }
      line.refundedQty = round3(line.refundedQty + p.qty);
      line.refundedAmount += p.amount;
    }
    sale.refundedTotal += total;
    sale.status = sale.lines.every((l) => l.qty - l.refundedQty < EPS) ? 'refunded' : 'partially_refunded';
    sale.markModified('lines');
    await sale.save({ session });

    const [refund] = await Refund.create(
      [
        {
          _id: refundId,
          shopId,
          saleId: sale._id,
          saleNumber: sale.number,
          number,
          branchId: sale.branchId,
          terminalId: shift.terminalId,
          shiftId: shift._id,
          cashierId: a.userId,
          lines: plan.map((p) => ({ lineIndex: p.index, productId: sale.lines[p.index].productId, name: sale.lines[p.index].name, qty: p.qty, amount: p.amount, unitCost: sale.lines[p.index].unitCost })),
          total,
          payout: input.method === 'debt' ? 0 : payout,
          method: input.method,
          reason: input.reason,
          restock: input.restock,
          approvedBy,
          bonusReversed,
          bonusRestored,
          debtReduced,
          clientRequestId: input.clientRequestId,
          fiscal,
        },
      ],
      { session },
    );

    if (customer) {
      const upd = await Customer.findOneAndUpdate(
        { _id: customer._id, shopId },
        { $inc: { bonusBalance: bonusRestored - bonusReversed, debtBalance: -debtReduced, totalSpent: -total } },
        { new: true, session },
      );
      customer = upd;
      const rows = [];
      if (bonusRestored) rows.push({ shopId, customerId: upd!._id, saleId: sale._id, refundId, type: 'spend_reversal', amount: bonusRestored, balanceAfter: upd!.bonusBalance + bonusReversed });
      if (bonusReversed) rows.push({ shopId, customerId: upd!._id, saleId: sale._id, refundId, type: 'earn_reversal', amount: -bonusReversed, balanceAfter: upd!.bonusBalance });
      if (rows.length) await BonusTransaction.create(rows, { session, ordered: true });
    }
    stockEvents = tx.events;
    return { refund: refund as RefundDoc, sale: sale as SaleDoc };
  });

  if (approvedBy) await auditSystem({ action: 'refund.approved', shopId, userId: a.userId, entity: 'refund', entityId: result.refund._id, meta: { approvedBy: String(approvedBy), total: result.refund.total, reason: input.reason }, ip: opts.ip });
  else await auditSystem({ action: 'refund.created', shopId, userId: a.userId, entity: 'refund', entityId: result.refund._id, meta: { total: result.refund.total, reason: input.reason }, ip: opts.ip });
  events.emitAll([...stockEvents, { name: 'sale.refunded', shopId, data: { id: String(result.refund._id), saleId: String(result.sale._id), number: result.refund.number, total: result.refund.total, branchId: String(result.sale.branchId) } }]);
  return { ...result, duplicate: false };
}
