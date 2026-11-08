import { describe, expect, it } from 'vitest';
import { applyPromotions, isPromotionActive, type CartLine, type PromotionDef } from './promotions';

const promo = (over: Partial<PromotionDef> & Pick<PromotionDef, 'id' | 'type' | 'rules'>): PromotionDef => ({
  name: over.id,
  priority: 0,
  allowStack: false,
  isActive: true,
  branchIds: [],
  ...over,
});
const line = (key: string, productId: string, qty: number, price: number, categoryIds: string[] = []): CartLine => ({ key, productId, qty, price, categoryIds });
const NOW = new Date('2026-11-06T09:00:00Z'); // Friday 14:00 Tashkent

describe('promotion activity', () => {
  it('respects dates, branches and the on/off flag', () => {
    const p = promo({ id: 'a', type: 'percent', rules: { percent: 10 }, startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-30T00:00:00Z', branchIds: ['b1'] });
    expect(isPromotionActive(p, 'b1', NOW)).toBe(true);
    expect(isPromotionActive(p, 'b2', NOW)).toBe(false);
    expect(isPromotionActive({ ...p, isActive: false }, 'b1', NOW)).toBe(false);
    expect(isPromotionActive(p, 'b1', new Date('2026-12-02T00:00:00Z'))).toBe(false);
    expect(isPromotionActive(p, 'b1', new Date('2026-10-01T00:00:00Z'))).toBe(false);
  });
  it('time-based discounts use Tashkent time and days of week', () => {
    const happy = promo({ id: 'h', type: 'percent', rules: { percent: 10 }, schedule: { days: [5], from: '13:00', to: '15:00' } });
    expect(isPromotionActive(happy, 'b', NOW)).toBe(true); // Fri 14:00
    expect(isPromotionActive(happy, 'b', new Date('2026-11-06T11:00:00Z'))).toBe(false); // Fri 16:00
    expect(isPromotionActive(happy, 'b', new Date('2026-11-07T09:00:00Z'))).toBe(false); // Sat
    const night = promo({ id: 'n', type: 'percent', rules: { percent: 5 }, schedule: { from: '22:00', to: '06:00' } });
    expect(isPromotionActive(night, 'b', new Date('2026-11-06T18:00:00Z'))).toBe(true); // 23:00 local
    expect(isPromotionActive(night, 'b', NOW)).toBe(false);
  });
});

describe('applyPromotions', () => {
  it('percent and fixed discounts on products and categories', () => {
    const promos = [
      promo({ id: 'p10', type: 'percent', rules: { percent: 10, categoryIds: ['drinks'] } }),
      promo({ id: 'f500', type: 'fixed', rules: { amount: 500, productIds: ['bread'] } }),
    ];
    const r = applyPromotions([line('1', 'cola', 2, 10_000, ['drinks']), line('2', 'bread', 3, 2_000), line('3', 'milk', 1, 8_000)], promos, 'b', NOW);
    expect(r.map((x) => [x.key, x.promotionId, x.discount])).toEqual([['1', 'p10', 2_000], ['2', 'f500', 1_500]]);
  });

  it('picks the best promotion per line, and priority breaks ties', () => {
    const promos = [
      promo({ id: 'small', type: 'percent', rules: { percent: 5 } }),
      promo({ id: 'big', type: 'percent', rules: { percent: 20, productIds: ['x'] } }),
      promo({ id: 'tieA', type: 'fixed', rules: { amount: 1000 }, priority: 1 }),
      promo({ id: 'tieB', type: 'fixed', rules: { amount: 1000 }, priority: 9 }),
    ];
    const r = applyPromotions([line('1', 'x', 1, 10_000), line('2', 'y', 1, 100_000), line('3', 'z', 1, 5_000)], promos, 'b', NOW);
    expect(r.find((x) => x.key === '1')!.promotionId).toBe('big'); // 2000 > 1000
    expect(r.find((x) => x.key === '2')!.promotionId).toBe('small'); // 5000 beats 1000
    expect(r.find((x) => x.key === '3')!.promotionId).toBe('tieB'); // 1000 vs 250: fixed; tie by priority
  });

  it('never discounts more than the line total', () => {
    const r = applyPromotions([line('1', 'a', 1, 300)], [promo({ id: 'f', type: 'fixed', rules: { amount: 5000 } })], 'b', NOW);
    expect(r[0].discount).toBe(300);
  });

  it('buy X get Y free', () => {
    const p = promo({ id: 'b2g1', type: 'buy_x_get_y', rules: { buyQty: 2, getQty: 1, productIds: ['tea'] } });
    expect(applyPromotions([line('1', 'tea', 7, 4_000)], [p], 'b', NOW)[0].discount).toBe(2 * 4_000); // 7 -> two groups of 3 -> 2 free
    expect(applyPromotions([line('1', 'tea', 2, 4_000)], [p], 'b', NOW)).toHaveLength(0);
  });

  it('bundle price applies per complete set', () => {
    const p = promo({ id: 'combo', type: 'bundle', rules: { items: [{ productId: 'burger', qty: 1 }, { productId: 'cola', qty: 1 }], bundlePrice: 25_000 } });
    const none = applyPromotions([line('1', 'burger', 1, 20_000)], [p], 'b', NOW);
    expect(none).toHaveLength(0);
    const one = applyPromotions([line('1', 'burger', 1, 20_000), line('2', 'cola', 1, 8_000)], [p], 'b', NOW);
    expect(one.reduce((s, x) => s + x.discount, 0)).toBe(3_000); // 28 000 -> 25 000
    const two = applyPromotions([line('1', 'burger', 2, 20_000), line('2', 'cola', 3, 8_000)], [p], 'b', NOW);
    expect(two.reduce((s, x) => s + x.discount, 0)).toBe(6_000); // two sets, the extra cola is full price
  });

  it('a bundle takes its lines away from single-line promotions', () => {
    const promos = [
      promo({ id: 'combo', type: 'bundle', rules: { items: [{ productId: 'a', qty: 1 }, { productId: 'b', qty: 1 }], bundlePrice: 10_000 }, priority: 5 }),
      promo({ id: 'all10', type: 'percent', rules: { percent: 10 } }),
    ];
    const r = applyPromotions([line('1', 'a', 1, 8_000), line('2', 'b', 1, 6_000), line('3', 'c', 1, 1_000)], promos, 'b1', NOW);
    expect(r.find((x) => x.key === '1')!.promotionId).toBe('combo');
    expect(r.find((x) => x.key === '3')!.promotionId).toBe('all10');
    expect(r.filter((x) => x.promotionId === 'combo').reduce((s, x) => s + x.discount, 0)).toBe(4_000);
  });
});
