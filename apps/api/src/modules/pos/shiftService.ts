import type { Types } from 'mongoose';
import { formatTashkent, translate, type Language } from '@kass/shared';
import { AuditLog, type BranchDoc, type ShopDoc, type TerminalDoc } from '../../models/core';
import { CashOperation, CustomerPayment, Refund, Sale, type ShiftDoc } from '../../models/sales';
import { receiptLabels } from './receipt';

export interface ShiftTotals {
  receipts: number;
  gross: number;
  discount: number;
  net: number;
  byMethod: { cash: number; card: number; bonus: number; credit: number };
  refunds: { count: number; total: number; cash: number; card: number; debt: number };
  cashIn: number;
  cashOut: number;
  debtRepayments: { cash: number; card: number };
  removedLines: number;
  openingCash: number;
  /** opening + cash sales - cash refunds + cash in - cash out + cash debt repayments */
  expectedCash: number;
}

/** Live totals of a shift: the X-report, and the numbers frozen into the Z-report at closing. */
export async function computeShiftTotals(shopId: Types.ObjectId, shift: Pick<ShiftDoc, '_id' | 'openingCash'>): Promise<ShiftTotals> {
  const [sales, refunds, ops, repayments, removed] = await Promise.all([
    Sale.find({ shopId, shiftId: shift._id }).select('subtotal discount total payments').lean(),
    Refund.find({ shopId, shiftId: shift._id }).select('total payout method').lean(),
    CashOperation.find({ shopId, shiftId: shift._id }).lean(),
    CustomerPayment.find({ shopId, shiftId: shift._id }).lean(),
    AuditLog.countDocuments({ shopId, action: 'pos.line_removed', entity: 'shift', entityId: String(shift._id) }),
  ]);
  const byMethod = { cash: 0, card: 0, bonus: 0, credit: 0 };
  let gross = 0;
  let discount = 0;
  let net = 0;
  for (const s of sales) {
    gross += s.subtotal;
    discount += s.discount;
    net += s.total;
    for (const p of s.payments ?? []) byMethod[p.method as keyof typeof byMethod] += p.amount ?? 0;
  }
  const refundTotals = { count: refunds.length, total: 0, cash: 0, card: 0, debt: 0 };
  for (const r of refunds as any[]) {
    refundTotals.total += r.total;
    // money that physically leaves: the payout (goods value minus bonus restored / credit offset)
    const payout = r.payout ?? r.total;
    refundTotals[r.method as 'cash' | 'card' | 'debt'] += payout;
  }
  const cashIn = ops.filter((o) => o.type === 'in').reduce((s, o) => s + o.amount, 0);
  const cashOut = ops.filter((o) => o.type === 'out').reduce((s, o) => s + o.amount, 0);
  const debtRepayments = {
    cash: repayments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amount, 0),
    card: repayments.filter((p) => p.method === 'card').reduce((s, p) => s + p.amount, 0),
  };
  const openingCash = shift.openingCash ?? 0;
  return {
    receipts: sales.length,
    gross,
    discount,
    net,
    byMethod,
    refunds: refundTotals,
    cashIn,
    cashOut,
    debtRepayments,
    removedLines: removed,
    openingCash,
    expectedCash: openingCash + byMethod.cash - refundTotals.cash + cashIn - cashOut + debtRepayments.cash,
  };
}

/** Structured X/Z report for the agent. */
export function buildShiftReport(
  kind: 'x' | 'z',
  shift: Pick<ShiftDoc, '_id' | 'openedAt' | 'closedAt' | 'cashierName' | 'countedCash' | 'difference'> & { totals?: unknown },
  totals: ShiftTotals,
  c: { shop: ShopDoc; branch: BranchDoc | null; terminal: TerminalDoc | null },
) {
  const lang = (c.shop.settings?.receiptLanguage ?? 'uz') as Language;
  return {
    type: kind === 'x' ? ('x_report' as const) : ('z_report' as const),
    language: lang,
    labels: { ...receiptLabels(lang), ...Object.fromEntries(['xReport', 'zReport', 'shift', 'opened', 'closed', 'openingCash', 'receipts', 'sales', 'returns', 'cashIn', 'cashOut', 'debtRepayments', 'expectedCash', 'countedCash', 'difference'].map((k) => [k, translate(lang, `receipt.${k}`)])) },
    currency: c.shop.currency,
    shop: { name: c.shop.name },
    branch: { name: c.branch?.name ?? '' },
    terminal: c.terminal?.name ?? '',
    cashier: shift.cashierName ?? '',
    openedAt: formatTashkent(shift.openedAt, true),
    closedAt: shift.closedAt ? formatTashkent(shift.closedAt, true) : null,
    shiftId: String(shift._id),
    totals,
    countedCash: shift.countedCash ?? null,
    difference: shift.difference ?? null,
  };
}
