import { formatTashkent, translate, type Language } from '@kass/shared';
import type { PricedLine } from './cart';

/**
 * Builds the structured receipt locally. Used for OFFLINE sales (the server cannot answer), so the
 * agent can still print; its shape matches the server's receipt payload.
 */
export interface LocalReceiptInput {
  shop: { name: string; currency: 'UZS' | 'USD' | 'RUB'; logoUrl?: string | null; tin?: string | null; settings: { receiptLanguage: Language; receiptHeader?: string; receiptFooter?: string } };
  branch: { name?: string; address?: string; phone?: string; receiptHeader?: string; receiptFooter?: string };
  terminalName: string;
  cashierName: string;
  number: string;
  createdAt: Date;
  lines: PricedLine[];
  subtotal: number;
  discount: number;
  total: number;
  payments: Array<{ method: string; amount: number }>;
  cashGiven: number;
  change: number;
  copy?: boolean;
}

const LABELS = ['receipt', 'copy', 'refund', 'number', 'date', 'cashier', 'terminal', 'customer', 'subtotal', 'discount', 'promotion', 'vat', 'total', 'cash', 'card', 'bonus', 'credit', 'cashGiven', 'change', 'bonusBalance', 'bonusEarned', 'fiscalSign', 'fiscalModule', 'fiscalReceipt', 'thanks', 'qty', 'mxik'] as const;

export function buildLocalReceipt(i: LocalReceiptInput) {
  const lang = i.shop.settings.receiptLanguage;
  const byRate = new Map<number, number>();
  for (const l of i.lines) if (l.vatRate && l.vatRate > 0) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + Math.round((l.total * l.vatRate) / (100 + l.vatRate)));
  return {
    type: 'sale' as const,
    language: lang,
    copy: !!i.copy,
    labels: Object.fromEntries(LABELS.map((k) => [k, translate(lang, `receipt.${k}`)])),
    currency: i.shop.currency,
    shop: { name: i.shop.name, logoUrl: i.shop.logoUrl ?? null, tin: i.shop.tin ?? null },
    branch: { name: i.branch.name ?? '', address: i.branch.address ?? '', phone: i.branch.phone ?? '' },
    header: i.branch.receiptHeader || i.shop.settings.receiptHeader || '',
    footer: i.branch.receiptFooter || i.shop.settings.receiptFooter || '',
    number: i.number,
    createdAt: formatTashkent(i.createdAt, true),
    cashier: i.cashierName,
    terminal: i.terminalName,
    customer: null,
    lines: i.lines.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, price: l.price, discount: l.promoDiscount + l.manualDiscount + l.receiptShare, promotion: l.promotionName ?? null, total: l.total, mxikCode: null })),
    subtotal: i.subtotal,
    discount: i.discount,
    vat: [...byRate.entries()].map(([rate, amount]) => ({ rate, amount })),
    total: i.total,
    payments: i.payments.map((p) => ({ method: p.method, label: translate(lang, `receipt.${p.method}`), amount: p.amount })),
    cashGiven: i.cashGiven,
    change: i.change,
    bonusEarned: 0,
    bonusBalance: null,
    fiscal: null,
    qr: i.number,
  };
}

/** Body for POST /sales (online) and the queued item for POST /sales/sync (offline). */
export function buildSaleBody(args: {
  clientRequestId: string;
  terminalId: string;
  shiftId: string;
  lines: PricedLine[];
  receiptDiscount: number;
  payments: Array<{ method: string; amount: number }>;
  customerId?: string | null;
  offline?: boolean;
  localNumber?: string;
  createdAt?: Date;
  approval?: { login: string; pin: string } | null;
}) {
  return {
    clientRequestId: args.clientRequestId,
    terminalId: args.terminalId,
    shiftId: args.shiftId,
    customerId: args.customerId || undefined,
    lines: args.lines.map((l) => ({
      productId: l.productId,
      qty: l.qty,
      discount: l.manualDiscount,
      markingCode: l.markingCode,
      // offline: the price and promotion actually charged are kept by the server ("charged price wins")
      ...(args.offline ? { price: l.price, ...(l.promotionId && l.promoDiscount ? { promotionId: l.promotionId, promoDiscount: l.promoDiscount } : {}) } : {}),
    })),
    discount: args.receiptDiscount,
    payments: args.payments,
    ...(args.offline ? { isOffline: true, localNumber: args.localNumber, createdAt: (args.createdAt ?? new Date()).toISOString() } : {}),
    ...(args.approval ? { approval: args.approval } : {}),
  };
}
