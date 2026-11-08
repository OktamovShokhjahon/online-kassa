import { describe, expect, it } from 'vitest';
import type { PromotionDef } from '@kass/shared';
import { addProduct, bonusEarned, checkPayments, emptyCart, manualDiscountPercent, maxBonusPayable, priceCart, removeLine, setLineDiscount, setQty, type Cart } from '../src/lib/pos/cart';

const p = (id: string, price: number, extra = {}) => ({ productId: id, name: id, unit: 'piece', price, isWeighted: false, isMarked: false, categoryIds: [] as string[], ...extra });
const promo = (over: Partial<PromotionDef> & Pick<PromotionDef, 'id' | 'type' | 'rules'>): PromotionDef => ({ name: over.id, priority: 0, allowStack: false, isActive: true, branchIds: [], ...over });
const build = (...items: Array<[ReturnType<typeof p>, number]>): Cart => items.reduce((c, [x, q]) => addProduct(c, x, q), emptyCart());

describe('cart lines', () => {
  it('merges the same product, but keeps marked goods one unit per line', () => {
    let c = addProduct(emptyCart(), p('cola', 1200));
    c = addProduct(c, p('cola', 1200), 2);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].qty).toBe(3);
    c = addProduct(c, p('vodka', 9000, { isMarked: true }));
    c = addProduct(c, p('vodka', 9000, { isMarked: true }));
    expect(c.lines.filter((l) => l.productId === 'vodka')).toHaveLength(2);
    expect(c.lines.every((l) => (l.isMarked ? l.qty === 1 : true))).toBe(true);
  });
  it('keeps weighed quantities exact to 3 decimals', () => {
    let c = addProduct(emptyCart(), p('rice', 1_500_000, { isWeighted: true, unit: 'kg' }), 0.1);
    c = addProduct(c, p('rice', 1_500_000), 0.2);
    expect(c.lines[0].qty).toBe(0.3);
    expect(setQty(c, c.lines[0].key, 1.255).lines[0].qty).toBe(1.255);
    expect(priceCart(setQty(c, c.lines[0].key, 1.255), [], 'b').total).toBe(Math.round(1.255 * 1_500_000));
    expect(removeLine(c, c.lines[0].key).lines).toHaveLength(0);
  });
});

describe('priceCart mirrors the server algorithm', () => {
  it('plain totals', () => {
    const r = priceCart(build([p('a', 1_200_000), 2], [p('b', 300_000), 1]), [], 'b1');
    expect(r.subtotal).toBe(2_700_000);
    expect(r.total).toBe(2_700_000);
    expect(r.lines.map((l) => l.total)).toEqual([2_400_000, 300_000]);
  });
  it('applies the best promotion automatically', () => {
    const r = priceCart(build([p('cola', 1_200_000), 2], [p('bread', 300_000), 1]), [promo({ id: 'x', name: 'Cola -10%', type: 'percent', rules: { percent: 10, productIds: ['cola'] } })], 'b1');
    expect(r.lines[0]).toMatchObject({ promoDiscount: 240_000, promotionName: 'Cola -10%', total: 2_160_000 });
    expect(r.lines[1].promoDiscount).toBe(0);
    expect(r.total).toBe(2_460_000);
  });
  it('manual discounts do not stack with a promotion unless it allows it', () => {
    const base = setLineDiscount(build([p('cola', 1_000_000), 1]), 'x', 0);
    const c = setLineDiscount(base, base.lines[0].key, 50_000);
    const promos = (allowStack: boolean) => [promo({ id: 'x', type: 'percent', allowStack, rules: { percent: 10 } })];
    expect(priceCart(c, promos(false), 'b').issues).toEqual([{ key: c.lines[0].key, code: 'PROMOTION_STACK' }]);
    const ok = priceCart(c, promos(true), 'b');
    expect(ok.issues).toEqual([]);
    expect(ok.total).toBe(1_000_000 - 100_000 - 50_000);
  });
  it('spreads a receipt discount proportionally; line totals always add up', () => {
    const c = { ...build([p('a', 100_000), 1], [p('b', 200_000), 1], [p('c', 333_333), 3]), receiptDiscount: 100_001 };
    const r = priceCart(c, [], 'b');
    expect(r.lines.reduce((s, l) => s + l.receiptShare, 0)).toBe(100_001);
    expect(r.lines.reduce((s, l) => s + l.total, 0)).toBe(r.total);
    expect(r.total).toBe(100_000 + 200_000 + 999_999 - 100_001);
  });
  it('flags discounts larger than the line and receipt discounts nothing can absorb', () => {
    const c = build([p('a', 1000), 1]);
    expect(priceCart(setLineDiscount(c, c.lines[0].key, 1001), [], 'b').issues[0].code).toBe('DISCOUNT_TOO_LARGE');
    expect(priceCart({ ...c, receiptDiscount: 5000 }, [], 'b').issues[0].code).toBe('DISCOUNT_TOO_LARGE');
  });
  it('computes the manual discount percentage against the amount after promotions', () => {
    const c = build([p('a', 1_000_000), 1]);
    const r = priceCart(setLineDiscount(c, c.lines[0].key, 100_000), [], 'b');
    expect(manualDiscountPercent(r)).toBe(10);
  });
  it('bundles and buy-X-get-Y come from the shared engine, identical to the server', () => {
    const bundle = promo({ id: 'combo', type: 'bundle', rules: { items: [{ productId: 'a', qty: 1 }, { productId: 'b', qty: 1 }], bundlePrice: 1_300_000 } });
    const r = priceCart(build([p('a', 1_200_000), 1], [p('b', 300_000), 1]), [bundle], 'b');
    expect(r.total).toBe(1_300_000);
    const bxgy = promo({ id: 'g', type: 'buy_x_get_y', rules: { buyQty: 2, getQty: 1, productIds: ['tea'] } });
    expect(priceCart(build([p('tea', 400_000), 3]), [bxgy], 'b').total).toBe(800_000);
  });
});

describe('payments', () => {
  it('cash balances the receipt and returns change; non-cash must be exact', () => {
    expect(checkPayments(1_200_000, [{ method: 'cash', amount: 2_000_000 }])).toEqual({ ok: true, applied: [{ method: 'cash', amount: 1_200_000 }], cashDue: 1_200_000, change: 800_000 });
    expect(checkPayments(1_200_000, [{ method: 'card', amount: 500_000 }, { method: 'cash', amount: 1_000_000 }])).toMatchObject({ ok: true, cashDue: 700_000, change: 300_000 });
    expect(checkPayments(1_200_000, [{ method: 'cash', amount: 1_199_999 }])).toEqual({ ok: false, error: 'PAYMENT_INSUFFICIENT' });
    expect(checkPayments(1_200_000, [{ method: 'card', amount: 1_200_001 }])).toEqual({ ok: false, error: 'PAYMENT_MISMATCH' });
    expect(checkPayments(1_200_000, [{ method: 'card', amount: 1_200_000 }, { method: 'cash', amount: 1 }])).toEqual({ ok: false, error: 'PAYMENT_MISMATCH' });
  });
  it('bonus earn and spend limits', () => {
    expect(bonusEarned(1_000_000, 200_000, 2)).toBe(24_000);
    expect(maxBonusPayable(1_200_000, 900_000, 50)).toBe(600_000);
    expect(maxBonusPayable(1_200_000, 100_000, 50)).toBe(100_000);
  });
});
