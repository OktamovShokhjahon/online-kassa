import type { Types } from 'mongoose';
import { formatTashkent, translate, type Language } from '@kass/shared';
import type { BranchDoc, ShopDoc, TerminalDoc } from '../../models/core';
import type { CustomerDoc, RefundDoc, SaleDoc } from '../../models/sales';

/**
 * Structured receipt for the local agent (spec 7.3, 9.6). The POS never sends raw printer bytes;
 * the agent renders this into ESC/POS. Labels come pre-translated in the shop's receipt language.
 */
export const RECEIPT_LABEL_KEYS = [
  'receipt', 'copy', 'refund', 'number', 'date', 'cashier', 'terminal', 'customer', 'subtotal', 'discount', 'promotion', 'vat',
  'total', 'cash', 'card', 'bonus', 'credit', 'cashGiven', 'change', 'bonusBalance', 'bonusEarned', 'fiscalSign', 'fiscalModule',
  'fiscalReceipt', 'thanks', 'qty', 'mxik',
] as const;

export function receiptLabels(lang: Language): Record<string, string> {
  return Object.fromEntries(RECEIPT_LABEL_KEYS.map((k) => [k, translate(lang, `receipt.${k}`)]));
}

interface ReceiptCtx {
  shop: ShopDoc;
  branch: BranchDoc | null;
  terminal: TerminalDoc | null;
  customer?: CustomerDoc | null;
  copy?: boolean;
}

function vatBreakdown(lines: Array<{ total: number; vatRate?: number | null }>) {
  const byRate = new Map<number, number>();
  for (const l of lines) {
    if (l.vatRate === undefined || l.vatRate === null || l.vatRate <= 0) continue;
    const vat = Math.round((l.total * l.vatRate) / (100 + l.vatRate)); // prices include VAT
    byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + vat);
  }
  return [...byRate.entries()].map(([rate, amount]) => ({ rate, amount }));
}

export function buildSaleReceipt(sale: SaleDoc, c: ReceiptCtx) {
  const lang = (c.shop.settings?.receiptLanguage ?? 'uz') as Language;
  return {
    type: 'sale' as const,
    language: lang,
    copy: !!c.copy,
    labels: receiptLabels(lang),
    currency: c.shop.currency,
    shop: { name: c.shop.name, logoUrl: c.shop.logoUrl ?? null, tin: c.shop.tin ?? null },
    branch: { name: c.branch?.name ?? '', address: c.branch?.address ?? '', phone: c.branch?.phone ?? '' },
    header: c.branch?.receiptHeader || c.shop.settings?.receiptHeader || '',
    footer: c.branch?.receiptFooter || c.shop.settings?.receiptFooter || '',
    number: sale.number,
    createdAt: formatTashkent(sale.createdAt, true),
    cashier: sale.cashierName ?? '',
    terminal: c.terminal?.name ?? '',
    customer: c.customer ? { name: c.customer.fullName, phone: c.customer.phone, bonusBalance: c.customer.bonusBalance } : null,
    lines: sale.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      unit: l.unit,
      price: l.price,
      discount: (l.promoDiscount ?? 0) + (l.manualDiscount ?? 0) + (l.receiptDiscountShare ?? 0),
      promotion: l.promotionName ?? null,
      total: l.total,
      mxikCode: l.mxikCode ?? null,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    vat: vatBreakdown(sale.lines),
    total: sale.total,
    payments: sale.payments.map((p) => ({ method: p.method, label: translate(lang, `receipt.${p.method}`), amount: p.amount })),
    cashGiven: sale.cashGiven,
    change: sale.change,
    bonusEarned: sale.bonusEarned,
    bonusBalance: c.customer?.bonusBalance ?? null,
    fiscal: sale.fiscal?.sign ? { sign: sale.fiscal.sign, moduleId: sale.fiscal.moduleId, receiptId: sale.fiscal.receiptId, qr: sale.fiscal.qr } : null,
    /** QR with the receipt number: scanned at the till for a fast return. */
    qr: sale.number,
  };
}

export function buildRefundReceipt(refund: RefundDoc, sale: SaleDoc, c: ReceiptCtx & { cashierName?: string }) {
  const lang = (c.shop.settings?.receiptLanguage ?? 'uz') as Language;
  return {
    type: 'refund' as const,
    language: lang,
    copy: !!c.copy,
    labels: receiptLabels(lang),
    currency: c.shop.currency,
    shop: { name: c.shop.name, logoUrl: c.shop.logoUrl ?? null, tin: c.shop.tin ?? null },
    branch: { name: c.branch?.name ?? '', address: c.branch?.address ?? '', phone: c.branch?.phone ?? '' },
    header: c.branch?.receiptHeader || c.shop.settings?.receiptHeader || '',
    footer: c.branch?.receiptFooter || c.shop.settings?.receiptFooter || '',
    number: refund.number,
    originalNumber: sale.number,
    createdAt: formatTashkent(refund.createdAt ?? new Date(), true),
    cashier: c.cashierName ?? '',
    terminal: c.terminal?.name ?? '',
    customer: c.customer ? { name: c.customer.fullName, phone: c.customer.phone, bonusBalance: c.customer.bonusBalance } : null,
    lines: refund.lines.map((l) => ({ name: l.name, qty: l.qty, unit: null, price: l.qty ? Math.round((l.amount ?? 0) / l.qty) : 0, discount: 0, promotion: null, total: l.amount ?? 0, mxikCode: null })),
    subtotal: refund.total,
    discount: 0,
    vat: [],
    total: refund.total,
    payments: [{ method: refund.method, label: refund.method === 'debt' ? translate(lang, 'receipt.credit') : translate(lang, `receipt.${refund.method}`), amount: refund.total }],
    cashGiven: 0,
    change: 0,
    bonusEarned: 0,
    bonusBalance: c.customer?.bonusBalance ?? null,
    fiscal: refund.fiscal?.sign ? { sign: refund.fiscal.sign, moduleId: refund.fiscal.moduleId, receiptId: refund.fiscal.receiptId, qr: refund.fiscal.qr } : null,
    qr: refund.number,
  };
}

export type ObjectId = Types.ObjectId;
