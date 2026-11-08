import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { events, type DomainEvent } from '../src/lib/events';
import { AuditLog, Shop } from '../src/models/core';
import { Customer, Refund, Sale, Shift } from '../src/models/sales';
import { Stock, StockMovement } from '../src/models/stock';
import { P, api, bearer } from './helpers';
import { BREAD, COLA, posCtx } from './posCtx';

const captured: DomainEvent[] = [];
beforeEach(() => {
  captured.length = 0;
  events.clear();
  events.on((e) => void captured.push(e));
});

const qty = async (t: any, productId: string) => (await Stock.findOne({ shopId: t.shop.shopId, branchId: t.shop.branchId, productId }).lean())!.quantity;

describe('shifts (spec 7.1, 7.5)', () => {
  it('opens one shift per terminal; the POS can see who holds it', async () => {
    const t = await posCtx({ openShift: false });
    const open = await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 250_000 }, t.cashier.h);
    expect(open.status).toBe(201);
    expect(open.body.data).toMatchObject({ status: 'open', openingCash: 250_000, cashierName: expect.any(String) });
    const second = await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.A); // the owner may open shifts too
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('SHIFT_ALREADY_OPEN');
    const cur = await t.get(`/shifts/current?terminalId=${t.term.id}`, t.cashier.h);
    expect(cur.body.data).toMatchObject({ id: open.body.data.id, mine: true });
    const other = await t.get(`/shifts/current?terminalId=${t.term.id}`, t.A);
    expect(other.body.data.mine).toBe(false);
    expect(other.body.data.totals).toBeUndefined();
  });

  it('computes expected cash = opening + cash sales - cash refunds + cash in - cash out; closing records the difference', async () => {
    const t = await posCtx();
    await t.sell([{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 5_000_000 }]);
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'card', amount: COLA.price }]); // card is not in the drawer
    await t.post('/cash-operations', { shiftId: t.shiftId, type: 'in', amount: 50_000, comment: 'change money' }, t.cashier.h);
    await t.post('/cash-operations', { shiftId: t.shiftId, type: 'out', amount: 20_000, comment: 'owner collection' }, t.cashier.h);

    const x = (await t.get(`/shifts/${t.shiftId}/x-report`, t.cashier.h)).body.data;
    expect(x.totals).toMatchObject({ receipts: 2, openingCash: 100_000, cashIn: 50_000, cashOut: 20_000 });
    expect(x.totals.byMethod).toMatchObject({ cash: 2_700_000, card: 1_200_000 });
    expect(x.totals.expectedCash).toBe(100_000 + 2_700_000 + 50_000 - 20_000);
    expect(x.report.type).toBe('x_report');

    const sale = (await Sale.findOne({ shopId: t.shop.shopId, 'lines.productId': t.bread.id }).lean())!;
    const refund = await t.post('/refunds', { saleId: String(sale._id), method: 'cash', reason: 'changed mind', lines: [{ productId: t.bread.id, qty: 1 }], approval: { login: t.manager.login, pin: '9999' } }, t.cashier.h);
    expect(refund.status).toBe(201);

    const close = await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 2_500_000 }, t.cashier.h);
    expect(close.status).toBe(200);
    const expected = 100_000 + 2_700_000 - 300_000 + 50_000 - 20_000;
    expect(close.body.data.shift).toMatchObject({ status: 'closed', expectedCash: expected, countedCash: 2_500_000, difference: 2_500_000 - expected });
    expect(close.body.data.report.type).toBe('z_report');
    expect(close.body.data.report.totals.refunds.cash).toBe(300_000);
    expect(captured.find((e) => e.name === 'shift.closed')!.data).toMatchObject({ difference: 2_500_000 - expected });
    // closed shifts accept no sales, no cash operations, no second close
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }])).body.error.code).toBe('SHIFT_CLOSED');
    expect((await t.post('/cash-operations', { shiftId: t.shiftId, type: 'in', amount: 1, comment: 'late' }, t.cashier.h)).status).toBe(422);
    expect((await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 0 }, t.cashier.h)).body.error.code).toBe('SHIFT_CLOSED');
    // a new shift can be opened afterwards
    expect((await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.cashier.h)).status).toBe(201);
  });

  it('shift closing requires every queued offline sale to be sent', async () => {
    const t = await posCtx();
    const r = await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 100_000, unsentOfflineCount: 2 }, t.cashier.h);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('UNSENT_SALES');
    expect((await Shift.findOne({ _id: t.shiftId, shopId: t.shop.shopId }))!.status).toBe('open');
  });

  it('Z-report labels follow the shop receipt language', async () => {
    const t = await posCtx();
    await t.patch('/settings', { receiptLanguage: 'ru' });
    const x = (await t.get(`/shifts/${t.shiftId}/x-report`, t.cashier.h)).body.data.report;
    expect(x.language).toBe('ru');
    expect(x.labels.total).toBe('ИТОГО');
    expect(x.labels.expectedCash).toBe('Ожидается');
  });

  it('cashiers only see their own shifts; managers see their branch', async () => {
    const t = await posCtx();
    const other = await t.staff('cashier');
    expect((await t.get(`/shifts/${t.shiftId}`, other.h)).status).toBe(404);
    expect((await t.get('/shifts', other.h)).body.data).toHaveLength(0);
    expect((await t.get('/shifts', t.manager.h)).body.data).toHaveLength(1);
  });

  it('logs removed lines for the staff-activity report', async () => {
    const t = await posCtx();
    const r = await t.post(`/shifts/${t.shiftId}/removed-lines`, { items: [{ name: 'Cola 1L', qty: 1, price: COLA.price }, { name: 'Bread', qty: 2, reason: 'cart_cleared' }] }, t.cashier.h);
    expect(r.body.data.logged).toBe(2);
    expect(await AuditLog.countDocuments({ shopId: t.shop.shopId, action: 'pos.line_removed' })).toBe(2);
    expect((await t.get(`/shifts/${t.shiftId}/x-report`, t.cashier.h)).body.data.totals.removedLines).toBe(2);
  });
});

describe('selling (spec 7.2)', () => {
  it('sells at the branch price, decreases stock, snapshots cost, prints change and numbers receipts', async () => {
    const t = await posCtx();
    const r = await t.sell([{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 5_000_000 }]);
    expect(r.status).toBe(201);
    const s = r.body.data;
    expect(s).toMatchObject({ subtotal: 2_700_000, total: 2_700_000, discount: 0, change: 2_300_000, cashGiven: 5_000_000, status: 'completed', number: '1-000001' });
    expect(s.payments).toEqual([{ method: 'cash', amount: 2_700_000 }]);
    expect(s.lines[0]).toMatchObject({ name: 'Cola 1L', qty: 2, price: COLA.price, total: 2_400_000, unitCost: COLA.cost });
    expect(await qty(t, t.cola.id)).toBe(98);
    expect(await qty(t, t.bread.id)).toBe(99);
    const second = await t.sell([{ productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: BREAD.price }]);
    expect(second.body.data.number).toBe('1-000002');
    expect(captured.some((e) => e.name === 'sale.created')).toBe(true);
    // the receipt payload is ready for the agent: labels in the receipt language, QR with the number
    expect(s.receipt).toMatchObject({ type: 'sale', language: 'uz', qr: '1-000001', total: 2_700_000, change: 2_300_000 });
    expect(s.receipt.labels.total).toBe('JAMI');
    expect(s.receipt.vat).toEqual([{ rate: 12, amount: Math.round((2_400_000 * 12) / 112) }]);
  });

  it('ignores prices sent by an online client - the server price is authoritative', async () => {
    const t = await posCtx();
    const r = await t.sell([{ productId: t.cola.id, qty: 1, price: 1 }], [{ method: 'cash', amount: COLA.price }]);
    expect(r.body.data.total).toBe(COLA.price);
  });

  it('refuses products without a price in this branch, inactive and unknown products', async () => {
    const t = await posCtx();
    const noPrice = await t.product({ name: 'No price' });
    const r = await t.sell([{ productId: noPrice.id, qty: 1 }], [{ method: 'cash', amount: 100 }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('NO_PRICE');
    expect(r.body.error.message).toBe('Bu filialda narx yo\'q');
    await t.patch(`/products/${t.bread.id}`, { isActive: false });
    expect((await t.sell([{ productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: BREAD.price }])).body.error.code).toBe('PRODUCT_INACTIVE');
    expect((await t.sell([{ productId: '64b000000000000000000000', qty: 1 }], [{ method: 'cash', amount: 1 }])).status).toBe(404);
  });

  it('is idempotent on clientRequestId, also under concurrency', async () => {
    const t = await posCtx();
    const body = t.body([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    const results = await Promise.all([1, 2, 3, 4].map(() => t.post('/sales', body, t.cashier.h)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(1);
    expect(await qty(t, t.cola.id)).toBe(99);
    const again = await t.post('/sales', body, t.cashier.h);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
  });

  it('negative stock allowed by default: the sale proceeds with a warning', async () => {
    const t = await posCtx();
    const r = await t.sell([{ productId: t.cola.id, qty: 103 }], [{ method: 'cash', amount: 103 * COLA.price }]);
    expect(r.status).toBe(201);
    expect(r.body.data.warnings).toEqual([{ type: 'negative_stock', productId: t.cola.id, name: 'Cola 1L', balance: -3 }]);
    expect(r.body.data.lines[0].negativeStock).toBe(true);
    expect(await qty(t, t.cola.id)).toBe(-3);
    expect((await t.get('/stock/negative')).body.data[0]).toMatchObject({ productId: t.cola.id, quantity: -3 });
    expect(captured.some((e) => e.name === 'stock.negative')).toBe(true);
  });

  it('negative stock blocked: the sale is refused as a whole, nothing is saved or moved', async () => {
    const t = await posCtx();
    await t.patch('/settings', { allowNegativeStock: false });
    const r = await t.sell([{ productId: t.bread.id, qty: 1 }, { productId: t.cola.id, qty: 101 }], [{ method: 'cash', amount: 200 * COLA.price }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect(await qty(t, t.bread.id)).toBe(100);
    expect(await qty(t, t.cola.id)).toBe(100);
    expect((await t.sell([{ productId: t.cola.id, qty: 100 }], [{ method: 'cash', amount: 100 * COLA.price }])).status).toBe(201);
  });

  it('locks the currency with the first sale and keeps stock = sum of movements', async () => {
    const t = await posCtx();
    expect((await Shop.findById(t.shop.shopId))!.currencyLocked).toBe(true); // already locked by the receipt of stock
    await t.sell([{ productId: t.cola.id, qty: 3 }], [{ method: 'cash', amount: 3 * COLA.price }]);
    const agg = await StockMovement.aggregate([{ $match: { shopId: (await Shop.findById(t.shop.shopId))!._id, productId: (await Stock.findOne({ shopId: t.shop.shopId, quantity: 97 }).lean())!.productId } }, { $group: { _id: null, q: { $sum: '$quantity' } } }]);
    expect(agg[0].q).toBe(97);
  });

  it('weighed goods accept 3 decimals', async () => {
    const t = await posCtx();
    const rice = await t.product({ name: 'Rice', unit: 'kg', isWeighted: true });
    await t.receive(t.shop.branchId, t.supplierId, [[rice.id, 50, 800_000]]);
    await t.put('/prices', { changes: [{ productId: rice.id, branchId: t.shop.branchId, price: 1_500_000 }] });
    const r = await t.sell([{ productId: rice.id, qty: 1.255 }], [{ method: 'cash', amount: 2_000_000 }]);
    expect(r.body.data.total).toBe(Math.round(1.255 * 1_500_000));
    expect(await qty(t, rice.id)).toBe(48.745);
  });

  it('marked goods need their marking code, one unit per line', async () => {
    const t = await posCtx();
    const vodka = await t.product({ name: 'Marked item', isMarked: true });
    await t.receive(t.shop.branchId, t.supplierId, [[vodka.id, 10, 5_000_000]]);
    await t.put('/prices', { changes: [{ productId: vodka.id, branchId: t.shop.branchId, price: 9_000_000 }] });
    const miss = await t.sell([{ productId: vodka.id, qty: 1 }], [{ method: 'cash', amount: 9_000_000 }]);
    expect(miss.body.error.code).toBe('MARKING_CODE_REQUIRED');
    expect((await t.sell([{ productId: vodka.id, qty: 2, markingCode: '0104600000000000215abc' }], [{ method: 'cash', amount: 18_000_000 }])).body.error.code).toBe('MARKING_CODE_REQUIRED');
    const ok1 = await t.sell([{ productId: vodka.id, qty: 1, markingCode: '0104600000000000215abc\u001d93xyz' }], [{ method: 'cash', amount: 9_000_000 }]);
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.lines[0].markingCode).toContain('0104600000000000215abc');
  });

  it('sells on the cashier’s own shift only; terminals of other branches are off limits', async () => {
    const t = await posCtx();
    const other = await t.staff('cashier');
    const r = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], {}, other.h);
    expect(r.status).toBe(403);
    const b2 = await t.branch('Other branch');
    const cashier2 = await t.staff('cashier', { branchIds: [b2] });
    const r2 = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], {}, cashier2.h);
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('TERMINAL_BRANCH_MISMATCH');
  });
});

describe('payments (spec 7.2)', () => {
  it('splits between cash and card and calculates change only on cash', async () => {
    const t = await posCtx();
    const r = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'card', amount: 500_000 }, { method: 'cash', amount: 1_000_000 }]);
    expect(r.body.data.payments).toEqual([{ method: 'cash', amount: 700_000 }, { method: 'card', amount: 500_000 }]);
    expect(r.body.data.change).toBe(300_000);
  });

  it('rejects short cash, over-paid cards and cash with nothing due', async () => {
    const t = await posCtx();
    const lines = [{ productId: t.cola.id, qty: 1 }];
    expect((await t.sell(lines, [{ method: 'cash', amount: COLA.price - 1 }])).body.error.code).toBe('PAYMENT_INSUFFICIENT');
    expect((await t.sell(lines, [{ method: 'card', amount: COLA.price + 1 }])).body.error.code).toBe('PAYMENT_MISMATCH');
    expect((await t.sell(lines, [{ method: 'card', amount: COLA.price }, { method: 'cash', amount: 100 }])).body.error.code).toBe('PAYMENT_MISMATCH');
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
  });
});

describe('discounts and promotions (spec 6.4, 7.2)', () => {
  it('manual discount within the cashier limit goes through; above it needs a manager PIN', async () => {
    const t = await posCtx();
    await t.patch('/settings', { maxCashierDiscount: 10 });
    const lines = (d: number) => [{ productId: t.cola.id, qty: 1, discount: d }];
    const within = await t.sell(lines(120_000), [{ method: 'cash', amount: COLA.price }]); // 10 %
    expect(within.status).toBe(201);
    expect(within.body.data).toMatchObject({ total: COLA.price - 120_000, discount: 120_000 });

    const above = await t.sell(lines(300_000), [{ method: 'cash', amount: COLA.price }]); // 25 %
    expect(above.status).toBe(403);
    expect(above.body.error.code).toBe('DISCOUNT_APPROVAL_REQUIRED');

    const wrong = await t.sell(lines(300_000), [{ method: 'cash', amount: COLA.price }], { approval: { login: t.manager.login, pin: '0000' } });
    expect(wrong.body.error.code).toBe('APPROVAL_INVALID');
    const cashierAsApprover = await t.sell(lines(300_000), [{ method: 'cash', amount: COLA.price }], { approval: { login: t.cashier.login, pin: '1234' } });
    expect(cashierAsApprover.body.error.code).toBe('APPROVAL_INVALID'); // cashiers hold no discount right

    const approved = await t.sell(lines(300_000), [{ method: 'cash', amount: COLA.price }], { approval: { login: t.manager.login, pin: '9999' } });
    expect(approved.status).toBe(201);
    expect(approved.body.data.total).toBe(COLA.price - 300_000);
    expect(await AuditLog.countDocuments({ shopId: t.shop.shopId, action: 'sale.discount_approved' })).toBe(1);
  });

  it('a discount permission removes the limit; receipt-level discounts are spread over the lines', async () => {
    const t = await posCtx({ cashierPerms: ['sales.discount'] });
    const r = await t.sell([{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 1_500_000 }], { discount: 300_000 });
    expect(r.status).toBe(201);
    expect(r.body.data.total).toBe(1_200_000);
    expect(r.body.data.lines.reduce((s: number, l: any) => s + l.total, 0)).toBe(1_200_000);
    expect(r.body.data.lines.reduce((s: number, l: any) => s + l.receiptDiscountShare, 0)).toBe(300_000);
    expect((await t.sell([{ productId: t.bread.id, qty: 1, discount: BREAD.price + 1 }], [{ method: 'cash', amount: 1 }])).body.error.code).toBe('DISCOUNT_TOO_LARGE');
  });

  it('the best promotion is applied automatically and shown on the receipt', async () => {
    const t = await posCtx();
    const promo = await t.post('/promotions', { name: 'Cola -10%', type: 'percent', rules: { percent: 10, productIds: [t.cola.id] } });
    expect(promo.status).toBe(201);
    const r = await t.sell([{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 3_000_000 }]);
    expect(r.body.data.lines[0]).toMatchObject({ promotionName: 'Cola -10%', promoDiscount: 240_000, total: 2_160_000 });
    expect(r.body.data.lines[1].promoDiscount).toBe(0);
    expect(r.body.data.total).toBe(2_160_000 + BREAD.price);
    expect(r.body.data.receipt.lines[0].promotion).toBe('Cola -10%');
  });

  it('manual discounts do not stack with a promotion unless the promotion allows it', async () => {
    const t = await posCtx({ cashierPerms: ['sales.discount'] });
    const promo = (await t.post('/promotions', { name: 'Cola -10%', type: 'percent', rules: { percent: 10, productIds: [t.cola.id] } })).body.data;
    const lines = [{ productId: t.cola.id, qty: 1, discount: 50_000 }];
    const r = await t.sell(lines, [{ method: 'cash', amount: COLA.price }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PROMOTION_STACK');
    await t.put(`/promotions/${promo.id}`, { name: 'Cola -10%', type: 'percent', allowStack: true, rules: { percent: 10, productIds: [t.cola.id] } });
    const ok2 = await t.sell(lines, [{ method: 'cash', amount: COLA.price }]);
    expect(ok2.body.data.total).toBe(COLA.price - 120_000 - 50_000);
  });
});

describe('customers: loyalty and credit (spec 6.2, 6.3)', () => {
  async function withCustomer(t: Awaited<ReturnType<typeof posCtx>>, extra: Record<string, unknown> = {}) {
    await t.patch('/settings', { loyalty: { bonusPercent: 2, maxPayPercent: 50 } });
    // only users who manage customers may set a credit limit (a cashier's value would be dropped)
    const c = await t.post('/customers', { fullName: 'Ali Valiyev', phone: '+998 90 111 22 33', cardBarcode: 'CARD-0001', ...extra }, extra.creditLimit ? t.A : t.cashier.h);
    expect(c.status).toBe(201);
    return c.body.data as { id: string };
  }

  it('earns bonus on the paid part, spends it later, up to the shop maximum', async () => {
    const t = await posCtx();
    const c = await withCustomer(t);
    const r1 = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { customerId: c.id });
    expect(r1.body.data.bonusEarned).toBe(24_000); // 2 % of 1 200 000
    expect((await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!).toMatchObject({ bonusBalance: 24_000, totalSpent: COLA.price, receiptCount: 1 });
    expect(r1.body.data.receipt.bonusBalance).toBe(24_000);

    const r2 = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'bonus', amount: 24_000 }, { method: 'cash', amount: COLA.price - 24_000 }], { customerId: c.id });
    expect(r2.status).toBe(201);
    expect(r2.body.data.bonusSpent).toBe(24_000);
    const cust = (await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!;
    expect(cust.bonusBalance).toBe(Math.round(((COLA.price - 24_000) * 2) / 100));
    // more than the balance, or than 50 % of the receipt -> refused
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'bonus', amount: 500_000 }, { method: 'cash', amount: 700_000 }], { customerId: c.id })).body.error.code).toBe('BONUS_INSUFFICIENT');
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'bonus', amount: 24_000 }, { method: 'cash', amount: COLA.price }], { customerId: c.id })).body.error.code).toBe('BONUS_INSUFFICIENT'); // balance is now below 24 000
  });

  it('bonus and credit need a customer', async () => {
    const t = await posCtx({ cashierPerms: ['sales.credit'] });
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'credit', amount: COLA.price }])).body.error.code).toBe('CUSTOMER_REQUIRED');
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { customerId: '64b000000000000000000000' })).body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('credit sales need the permission, respect the credit limit and create debt; repayment lands in the shift cash', async () => {
    const t = await posCtx();
    const c = await withCustomer(t, { creditLimit: 2_000_000 });
    const noPerm = await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'credit', amount: COLA.price }], { customerId: c.id });
    expect(noPerm.status).toBe(403);
    expect(noPerm.body.error.code).toBe('SALE_CREDIT_FORBIDDEN');

    const mgrShift = await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.A); // blocked: cashier's shift is open
    expect(mgrShift.status).toBe(422);
    // grant the permission to the cashier and use the credit
    const cashier2 = await t.staff('cashier', { permissions: ['sales.credit'] });
    await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 100_000 }, t.cashier.h);
    const sh = (await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, cashier2.h)).body.data;
    const credit = (amount: number) =>
      t.post('/sales', t.body([{ productId: t.cola.id, qty: 1 }], [{ method: 'credit', amount }], { customerId: c.id, shiftId: sh.id }), cashier2.h);
    expect((await credit(COLA.price)).status).toBe(201);
    expect((await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!.debtBalance).toBe(COLA.price);
    const over = await credit(COLA.price); // 2 400 000 > limit 2 000 000
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('CREDIT_LIMIT');

    const pay = await t.post('/customer-payments', { customerId: c.id, amount: 500_000, method: 'cash' }, cashier2.h);
    expect(pay.status).toBe(201);
    expect(pay.body.data.debtBalance).toBe(COLA.price - 500_000);
    expect((await t.post('/customer-payments', { customerId: c.id, amount: 99_999_999, method: 'cash' }, cashier2.h)).body.error.code).toBe('DEBT_EXCEEDS');
    const x = (await t.get(`/shifts/${sh.id}/x-report`, cashier2.h)).body.data.totals;
    expect(x.byMethod.credit).toBe(COLA.price);
    expect(x.debtRepayments.cash).toBe(500_000);
    expect(x.expectedCash).toBe(500_000); // repayments are drawer money, credit sales are not
    // debtors report source
    expect((await t.get('/customers?debtOnly=true')).body.data.map((d: any) => d.id)).toEqual([c.id]);
  });
});

describe('customer returns (spec 7.4)', () => {
  async function soldCtx() {
    const t = await posCtx();
    const sale = (await t.sell([{ productId: t.cola.id, qty: 3 }, { productId: t.bread.id, qty: 2 }], [{ method: 'cash', amount: 4_200_000 }])).body.data;
    return { t, sale };
  }

  it('needs the refund permission or a manager PIN', async () => {
    const { t, sale } = await soldCtx();
    const body = { saleId: sale.id, method: 'cash', reason: 'defect', lines: [{ productId: t.cola.id, qty: 1 }] };
    const denied = await t.post('/refunds', body, t.cashier.h);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('APPROVAL_INVALID');
    expect((await t.post('/refunds', { ...body, approval: { login: t.manager.login, pin: '9999' } }, t.cashier.h)).status).toBe(201);
  });

  it('partial returns restock goods, update the receipt and never exceed what was sold', async () => {
    const { t, sale } = await soldCtx();
    const approval = { login: t.manager.login, pin: '9999' };
    const r1 = await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'defect', lines: [{ productId: t.cola.id, qty: 2 }], approval }, t.cashier.h);
    expect(r1.body.data).toMatchObject({ total: 2 * COLA.price, number: 'R-000001', method: 'cash' });
    expect(r1.body.data.receipt).toMatchObject({ type: 'refund', originalNumber: sale.number });
    expect(await qty(t, t.cola.id)).toBe(99);
    let s = (await Sale.findOne({ shopId: t.shop.shopId, _id: sale.id }))!;
    expect(s.status).toBe('partially_refunded');
    expect(s.lines[0].refundedQty).toBe(2);

    const over = await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'x1', lines: [{ productId: t.cola.id, qty: 2 }], approval }, t.cashier.h);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_SOLD');
    await t.post('/refunds', { saleId: sale.id, method: 'card', reason: 'rest', lines: [{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 2 }], approval }, t.cashier.h);
    s = (await Sale.findOne({ shopId: t.shop.shopId, _id: sale.id }))!;
    expect(s.status).toBe('refunded');
    expect(s.refundedTotal).toBe(s.total);
    expect(await qty(t, t.cola.id)).toBe(100);
    expect(await qty(t, t.bread.id)).toBe(100);
    const reasonless = await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: '', lines: [{ productId: t.cola.id, qty: 1 }], approval }, t.cashier.h);
    expect(reasonless.status).toBe(400);
    expect(captured.filter((e) => e.name === 'sale.refunded')).toHaveLength(2);
  });

  it('damaged goods go to write-off instead of back on the shelf; cost is kept', async () => {
    const { t, sale } = await soldCtx();
    await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'broken', restock: 'writeoff', lines: [{ productId: t.cola.id, qty: 1 }], approval: { login: t.manager.login, pin: '9999' } }, t.cashier.h);
    expect(await qty(t, t.cola.id)).toBe(97); // not restocked
    const types = (await StockMovement.find({ shopId: t.shop.shopId, productId: t.cola.id }).sort('createdAt')).map((m) => m.type);
    expect(types.slice(-2)).toEqual(['customer_return', 'write_off']);
  });

  it('two concurrent refunds of the same units cannot over-refund', async () => {
    const { t, sale } = await soldCtx();
    const approval = { login: t.manager.login, pin: '9999' };
    const results = await Promise.all([1, 2, 3].map(() => t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'race', lines: [{ productId: t.bread.id, qty: 2 }], approval }, t.cashier.h)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await qty(t, t.bread.id)).toBe(100);
    expect(await Refund.countDocuments({ shopId: t.shop.shopId })).toBe(1);
  });

  it('reverses loyalty on returns and can reduce customer debt', async () => {
    const t = await posCtx({ cashierPerms: ['sales.credit', 'sales.refund'] });
    await t.patch('/settings', { loyalty: { bonusPercent: 10, maxPayPercent: 50 } });
    const c = (await t.post('/customers', { fullName: 'Debtor', phone: '+998 91 000 00 01' }, t.cashier.h)).body.data;
    const sale = (await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: 700_000 }, { method: 'credit', amount: 500_000 }], { customerId: c.id })).body.data;
    expect(sale.bonusEarned).toBe(70_000);
    let cust = (await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!;
    expect(cust).toMatchObject({ bonusBalance: 70_000, debtBalance: 500_000 });

    const r = await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'returned', lines: [{ productId: t.cola.id, qty: 1 }] }, t.cashier.h);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ bonusReversed: 70_000, debtReduced: 500_000, payout: 700_000 }); // credit part offsets debt, cash part is paid out
    cust = (await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!;
    expect(cust).toMatchObject({ bonusBalance: 0, debtBalance: 0, totalSpent: 0 });
    // only the money that physically left the drawer reduces expected cash
    const x = (await t.get(`/shifts/${t.shiftId}/x-report`, t.cashier.h)).body.data.totals;
    expect(x.refunds.cash).toBe(700_000);
  });

  it('returns by receipt number and the receipt lookup is branch-scoped', async () => {
    const { t, sale } = await soldCtx();
    const found = await t.get(`/sales/by-number/${sale.number}`, t.cashier.h);
    expect(found.body.data.id).toBe(sale.id);
    expect((await t.get('/sales/by-number/9-999999', t.cashier.h)).body.error.code).toBe('SALE_NOT_FOUND');
  });
});

describe('reprint and receipt journal (spec 7.2)', () => {
  it('reprints a receipt of the current shift marked COPY and audits it', async () => {
    const t = await posCtx();
    const sale = (await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }])).body.data;
    const copy = await t.get(`/sales/${sale.id}/receipt`, t.cashier.h);
    expect(copy.body.data).toMatchObject({ copy: true, number: sale.number });
    expect(await AuditLog.countDocuments({ shopId: t.shop.shopId, action: 'sale.reprinted' })).toBe(1);
    await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 1_300_000 }, t.cashier.h);
    expect((await t.get(`/sales/${sale.id}/receipt`, t.cashier.h)).status).toBe(403); // old shift: manager only
    expect((await t.get(`/sales/${sale.id}/receipt`, t.manager.h)).status).toBe(200);
  });

  it('lists receipts with filters; a cashier sees only their own', async () => {
    const t = await posCtx();
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    await t.sell([{ productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: BREAD.price }]);
    const mgr = await t.get(`/sales?productId=${t.bread.id}`, t.manager.h);
    expect(mgr.body.meta.total).toBe(1);
    expect((await t.get('/sales', t.cashier.h)).body.meta.total).toBe(2);
    const other = await t.staff('cashier');
    expect((await t.get('/sales', other.h)).body.meta.total).toBe(0);
  });
});

describe('offline mode and sync (spec 7.6)', () => {
  const offlineSale = (t: any, extra: Record<string, unknown> = {}, lines?: any[], payments?: any[]) =>
    t.body(lines ?? [{ productId: t.cola.id, qty: 1, price: COLA.price }], payments ?? [{ method: 'cash', amount: COLA.price }], { isOffline: true, localNumber: 'L-0001', createdAt: new Date(Date.now() - 3600_000).toISOString(), ...extra });

  it('applies queued sales idempotently, keeps their time and the price actually charged', async () => {
    const t = await posCtx();
    const earlier = new Date(Date.now() - 2 * 3600_000).toISOString();
    // the owner changed the price after the offline sale was made
    await t.put('/prices', { changes: [{ productId: t.cola.id, branchId: t.shop.branchId, price: 1_500_000 }] });
    const s1 = offlineSale(t, { createdAt: earlier, localNumber: 'L-1' });
    const s2 = offlineSale(t, { localNumber: 'L-2' }, [{ productId: t.bread.id, qty: 2, price: BREAD.price }], [{ method: 'cash', amount: 2 * BREAD.price }]);
    const r = await t.post('/sales/sync', { sales: [s1, s2] }, t.cashier.h);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.status)).toEqual(['created', 'created']);
    expect(r.body.data[0].conflicts).toEqual([{ kind: 'price_changed', productId: t.cola.id, charged: COLA.price, current: 1_500_000 }]);
    const stored = (await Sale.findOne({ shopId: t.shop.shopId, clientRequestId: s1.clientRequestId }))!;
    expect(stored).toMatchObject({ total: COLA.price, isOffline: true, localNumber: 'L-1' });
    expect(stored.createdAt.toISOString()).toBe(earlier);
    expect(stored.syncedAt).toBeTruthy();

    // sending the same batch again creates nothing new
    const again = await t.post('/sales/sync', { sales: [s1, s2] }, t.cashier.h);
    expect(again.body.data.map((x: any) => x.status)).toEqual(['duplicate', 'duplicate']);
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(2);
    expect(await qty(t, t.cola.id)).toBe(99);
    expect(await qty(t, t.bread.id)).toBe(98);
    // shows up in the offline sync report source
    expect((await t.get('/sales?offline=true', t.manager.h)).body.meta.total).toBe(2);
  });

  it('one bad sale never blocks the rest of the batch', async () => {
    const t = await posCtx();
    const good = offlineSale(t);
    const bad = offlineSale(t, {}, [{ productId: '64b000000000000000000000', qty: 1, price: 100 }], [{ method: 'cash', amount: 100 }]);
    const good2 = offlineSale(t, {}, [{ productId: t.bread.id, qty: 1, price: BREAD.price }], [{ method: 'cash', amount: BREAD.price }]);
    const r = await t.post('/sales/sync', { sales: [good, bad, good2] }, t.cashier.h);
    expect(r.body.data.map((x: any) => x.status)).toEqual(['created', 'error', 'created']);
    expect(r.body.data[1].error.code).toBe('PRODUCT_NOT_FOUND');
    expect(r.body.data[1].error.message).toBeTruthy();
  });

  it('refuses bonus and credit payments made offline', async () => {
    const t = await posCtx({ cashierPerms: ['sales.credit'] });
    const c = (await t.post('/customers', { fullName: 'Offline Guy', phone: '+998 90 555 55 55' }, t.cashier.h)).body.data;
    const credit = offlineSale(t, { customerId: c.id }, undefined, [{ method: 'credit', amount: COLA.price }]);
    const r = await t.post('/sales/sync', { sales: [credit] }, t.cashier.h);
    expect(r.body.data[0]).toMatchObject({ status: 'error', error: { code: 'OFFLINE_NOT_ALLOWED' } });
  });

  it('a price taken away meanwhile is still honoured and recorded as a conflict', async () => {
    const t = await posCtx();
    await t.put('/prices', { changes: [{ productId: t.bread.id, branchId: t.shop.branchId, price: null }] });
    const s = offlineSale(t, {}, [{ productId: t.bread.id, qty: 1, price: BREAD.price }], [{ method: 'cash', amount: BREAD.price }]);
    const r = await t.post('/sales/sync', { sales: [s] }, t.cashier.h);
    expect(r.body.data[0].status).toBe('created');
    expect(r.body.data[0].conflicts[0]).toMatchObject({ kind: 'price_removed', charged: BREAD.price });
  });

  it('offline promotions are kept as charged', async () => {
    const t = await posCtx();
    const promo = (await t.post('/promotions', { name: 'Offline promo', type: 'percent', rules: { percent: 10 } })).body.data;
    const s = offlineSale(t, {}, [{ productId: t.cola.id, qty: 1, price: COLA.price, promotionId: promo.id, promoDiscount: 100_000 }], [{ method: 'cash', amount: COLA.price - 100_000 }]);
    const r = await t.post('/sales/sync', { sales: [s] }, t.cashier.h);
    expect(r.body.data[0].status).toBe('created');
    expect((await Sale.findOne({ shopId: t.shop.shopId }))!.total).toBe(COLA.price - 100_000);
  });
});

describe('POS catalog feed (spec 7.6)', () => {
  it('returns the branch catalog, prices, promotions and customers; incremental sync reports changes and removed prices', async () => {
    const t = await posCtx();
    await t.post('/promotions', { name: 'Promo', type: 'percent', rules: { percent: 5 } });
    await t.post('/customers', { fullName: 'Cust', phone: '+998 90 777 77 77' }, t.cashier.h);
    const full = (await t.get(`/pos/catalog?terminalId=${t.term.id}`, t.cashier.h)).body.data;
    expect(full.full).toBe(true);
    expect(full.products.map((p: any) => p.name).sort()).toEqual(['Bread', 'Cola 1L']);
    expect(full.prices).toHaveLength(2);
    expect(full.promotions).toHaveLength(1);
    expect(full.customers).toHaveLength(1);
    expect(full.shop).toMatchObject({ currency: 'UZS', fiscalEnabled: false });
    expect(full.products[0].categoryIds).toEqual([]);

    await new Promise((r) => setTimeout(r, 20));
    const since = full.serverTime;
    await new Promise((r) => setTimeout(r, 20));
    await t.put('/prices', { changes: [{ productId: t.cola.id, branchId: t.shop.branchId, price: 1_300_000 }, { productId: t.bread.id, branchId: t.shop.branchId, price: null }] });
    const inc = (await t.get(`/pos/catalog?terminalId=${t.term.id}&since=${encodeURIComponent(since)}`, t.cashier.h)).body.data;
    expect(inc.full).toBe(false);
    expect(inc.prices).toEqual([{ productId: t.cola.id, price: 1_300_000 }]);
    expect(inc.removedPriceProductIds).toEqual([t.bread.id]);
    expect(inc.products).toHaveLength(0);
  });
});

describe('POS tenant isolation', () => {
  it("shop B cannot use, read or refund shop A's terminals, shifts and receipts", async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    const sale = (await a.sell([{ productId: a.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }])).body.data;

    expect((await b.get(`/sales/${sale.id}`, b.cashier.h)).status).toBe(404);
    expect((await b.get(`/sales/by-number/${sale.number}`, b.cashier.h)).status).toBe(404);
    expect((await b.get(`/shifts/${a.shiftId}`, b.cashier.h)).status).toBe(404);
    // selling on A's terminal/shift with B's credentials
    const hijack = await b.post('/sales', a.body([{ productId: b.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]), b.cashier.h);
    expect(hijack.status).toBe(404);
    const refund = await b.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'steal', lines: [{ productId: a.cola.id, qty: 1 }], approval: { login: b.manager.login, pin: '9999' } }, b.cashier.h);
    expect(refund.status).toBe(404);
    expect((await b.post(`/shifts/${a.shiftId}/close`, { countedCash: 0 }, b.cashier.h)).status).toBe(404);
    expect((await b.get('/sales', b.manager.h)).body.meta.total).toBe(0);
    expect(await qty(a, a.cola.id)).toBe(99);
    expect(randomUUID()).toBeTruthy();
    expect(api).toBeTruthy();
    expect(bearer('x')).toBeTruthy();
    expect(P).toBe('/api/v1');
  });
});
