import { applyPromotions, type CartLine as PromoCartLine, type PromotionDef } from '@kass/shared';

/**
 * Cart arithmetic of the POS. It follows the server's sale algorithm exactly (line gross, best
 * promotion, manual discounts, proportional receipt discount, payments, bonus), so what the cashier
 * sees - and what an offline sale charges - equals what the server computes. All amounts are integer
 * minor units; quantities have at most 3 decimals.
 */
export interface CartLine {
  key: string;
  productId: string;
  name: string;
  barcode?: string;
  unit: string;
  qty: number;
  price: number;
  vatRate?: number | null;
  isWeighted: boolean;
  isMarked: boolean;
  markingCode?: string;
  categoryIds: string[];
  /** Manual discount on this line, minor units. */
  manualDiscount: number;
}

export interface Cart {
  lines: CartLine[];
  /** Manual discount on the whole receipt, minor units. */
  receiptDiscount: number;
  customerId?: string | null;
}

export interface PricedLine extends CartLine {
  gross: number;
  promoDiscount: number;
  promotionId?: string;
  promotionName?: string;
  /** A manual discount may be added on top of this line's promotion. */
  stackable: boolean;
  receiptShare: number;
  total: number;
}

export interface Priced {
  lines: PricedLine[];
  subtotal: number;
  promoTotal: number;
  manualTotal: number;
  total: number;
  /** Problems the cashier must fix before paying. */
  issues: Array<{ key: string; code: 'PROMOTION_STACK' | 'DISCOUNT_TOO_LARGE' }>;
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const emptyCart = (): Cart => ({ lines: [], receiptDiscount: 0, customerId: null });

let seq = 0;
export const newKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Adds a product: the same product merges into one line, except marked goods (one unit per line). */
export function addProduct(cart: Cart, p: Omit<CartLine, 'key' | 'qty' | 'manualDiscount'>, qty = 1): Cart {
  if (!p.isMarked) {
    const i = cart.lines.findIndex((l) => l.productId === p.productId && !l.isMarked);
    if (i >= 0) return { ...cart, lines: cart.lines.map((l, j) => (j === i ? { ...l, qty: round3(l.qty + qty) } : l)) };
  }
  return { ...cart, lines: [...cart.lines, { ...p, key: newKey(), qty: p.isMarked ? 1 : qty, manualDiscount: 0 }] };
}

export const setQty = (cart: Cart, key: string, qty: number): Cart => ({ ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, qty: round3(qty) } : l)) });
export const removeLine = (cart: Cart, key: string): Cart => ({ ...cart, lines: cart.lines.filter((l) => l.key !== key) });
export const setLineDiscount = (cart: Cart, key: string, amount: number): Cart => ({ ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, manualDiscount: Math.max(0, Math.round(amount)) } : l)) });

/** Prices the cart: promotions first, then manual discounts, then the proportional receipt discount. */
export function priceCart(cart: Cart, promotions: PromotionDef[], branchId: string, now = new Date()): Priced {
  const promoLines: PromoCartLine[] = cart.lines.map((l, i) => ({ key: String(i), productId: l.productId, categoryIds: l.categoryIds, qty: l.qty, price: l.price }));
  const applied = new Map(applyPromotions(promoLines, promotions, branchId, now).map((a) => [a.key, a]));
  const issues: Priced['issues'] = [];

  const rows = cart.lines.map((l, i) => {
    const gross = Math.round(l.qty * l.price);
    const ap = applied.get(String(i));
    const promoDiscount = ap?.discount ?? 0;
    const stackable = !ap || ap.allowStack;
    if (promoDiscount > 0 && !stackable && l.manualDiscount > 0) issues.push({ key: l.key, code: 'PROMOTION_STACK' });
    if (promoDiscount + l.manualDiscount > gross) issues.push({ key: l.key, code: 'DISCOUNT_TOO_LARGE' });
    return { l, gross, promoDiscount, ap, stackable, net: gross - promoDiscount - l.manualDiscount, share: 0 };
  });

  if (cart.receiptDiscount > 0) {
    const eligible = rows.filter((r) => r.stackable && r.net > 0);
    const base = eligible.reduce((s, r) => s + r.net, 0);
    if (!eligible.length || cart.receiptDiscount > base) issues.push({ key: '', code: eligible.length ? 'DISCOUNT_TOO_LARGE' : 'PROMOTION_STACK' });
    else {
      let left = cart.receiptDiscount;
      eligible.forEach((r, idx) => {
        const share = idx === eligible.length - 1 ? left : Math.min(r.net, Math.round((cart.receiptDiscount * r.net) / base));
        r.share = share;
        left -= share;
      });
    }
  }

  const lines: PricedLine[] = rows.map((r) => ({
    ...r.l,
    gross: r.gross,
    promoDiscount: r.promoDiscount,
    promotionId: r.ap?.promotionId,
    promotionName: r.ap?.name,
    stackable: r.stackable,
    receiptShare: r.share,
    total: r.net - r.share,
  }));
  const subtotal = lines.reduce((s, l) => s + l.gross, 0);
  const promoTotal = lines.reduce((s, l) => s + l.promoDiscount, 0);
  return { lines, subtotal, promoTotal, manualTotal: lines.reduce((s, l) => s + l.manualDiscount, 0) + cart.receiptDiscount, total: lines.reduce((s, l) => s + l.total, 0), issues };
}

/** Manual discount as a percentage of what remains after promotions (compared with the cashier limit). */
export function manualDiscountPercent(p: Priced): number {
  const base = p.subtotal - p.promoTotal;
  return base > 0 ? (p.manualTotal / base) * 100 : 0;
}

export type PayMethod = 'cash' | 'card' | 'bonus' | 'credit';
export interface PaymentInput { method: PayMethod; amount: number }

export type PaymentCheck =
  | { ok: true; applied: Array<{ method: PayMethod; amount: number }>; cashDue: number; change: number }
  | { ok: false; error: 'PAYMENT_MISMATCH' | 'PAYMENT_INSUFFICIENT' };

/**
 * Cash is the balancing method: non-cash amounts must be exact, cash may exceed what is due
 * (the difference is change) but never falls short.
 */
export function checkPayments(total: number, payments: PaymentInput[]): PaymentCheck {
  const sum = { cash: 0, card: 0, bonus: 0, credit: 0 };
  for (const p of payments) sum[p.method] += p.amount;
  const nonCash = sum.card + sum.bonus + sum.credit;
  const cashDue = total - nonCash;
  if (cashDue < 0 || (cashDue === 0 && sum.cash > 0)) return { ok: false, error: 'PAYMENT_MISMATCH' };
  if (sum.cash < cashDue) return { ok: false, error: 'PAYMENT_INSUFFICIENT' };
  const applied = (['cash', 'card', 'bonus', 'credit'] as const).map((method) => ({ method, amount: method === 'cash' ? cashDue : sum[method] })).filter((p) => p.amount > 0);
  return { ok: true, applied, cashDue, change: sum.cash - cashDue };
}

/** Bonus earned on the part actually paid in cash or by card. */
export const bonusEarned = (cashDue: number, card: number, percent: number) => Math.round(((cashDue + card) * percent) / 100);

export function maxBonusPayable(total: number, balance: number, maxPercent: number) {
  return Math.max(0, Math.min(balance, Math.floor((total * maxPercent) / 100)));
}
