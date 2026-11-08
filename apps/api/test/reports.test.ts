import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { tashkentDateString } from '@kass/shared';
import { Customer, Sale } from '../src/models/sales';
import { Stock } from '../src/models/stock';
import { P, api, bearer } from './helpers';
import { BREAD, COLA, posCtx } from './posCtx';

const binary = (res: any, cb: any) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * One shop with a realistic day of trading (all numbers below are hand-computed):
 *  today:     S1 = 2 cola + 1 bread cash (2 700 000, cost 1 550 000), S2 = 1 cola card (1 200 000, cost 700 000)
 *             refund of the bread (300 000), write-off of 1 cola (700 000 at cost)
 *  yesterday: one offline sale of 2 bread (600 000, cost 300 000)
 */
async function scenario() {
  const t = await posCtx({ cashierPerms: ['sales.refund', 'sales.credit'] });
  await t.patch('/settings', { loyalty: { bonusPercent: 2, maxPayPercent: 50 } });
  const cust = (await t.post('/customers', { fullName: 'Reporter', phone: '+998 90 123 00 00' }, t.cashier.h)).body.data;
  const s1 = (await t.sell([{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 2_700_000 }], { customerId: cust.id })).body.data;
  const s2 = (await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'card', amount: 1_200_000 }])).body.data;
  const refund = await t.post('/refunds', { saleId: s1.id, method: 'cash', reason: 'changed mind', lines: [{ productId: t.bread.id, qty: 1 }] }, t.cashier.h);
  expect(refund.status).toBe(201);
  await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'expired', post: true, lines: [{ productId: t.cola.id, qty: 1 }] });
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
  const off = await t.post('/sales/sync', { sales: [t.body([{ productId: t.bread.id, qty: 2, price: BREAD.price }], [{ method: 'cash', amount: 600_000 }], { isOffline: true, createdAt: yesterday, localNumber: 'L-77' })] }, t.cashier.h);
  expect(off.body.data[0].status).toBe('created');
  const rep = async (key: string, qs = '', h = t.A) => (await t.get(`/reports/${key}${qs ? `?${qs}` : ''}`, h)).body;
  return { t, cust, s1, s2, rep };
}

describe('reports (spec 11.2)', () => {
  it('sales by period: revenue, receipts, average, discounts, returns and net revenue per day', async () => {
    const { t, rep } = await scenario();
    const r = await rep('sales');
    const today = r.data.rows.find((x: any) => x.date === tashkentDateString(new Date()));
    expect(today).toMatchObject({ receipts: 2, revenue: 3_900_000, avgReceipt: 1_950_000, discounts: 0, returns: 300_000, netRevenue: 3_600_000 });
    const yesterday = r.data.rows.find((x: any) => x.date === tashkentDateString(new Date(Date.now() - 86_400_000)));
    expect(yesterday).toMatchObject({ receipts: 1, revenue: 600_000, returns: 0, netRevenue: 600_000 });
    expect(r.data.totals).toMatchObject({ receipts: 3, revenue: 4_500_000, returns: 300_000, netRevenue: 4_200_000 });
    expect(r.data.currency).toBe('UZS');
    expect(r.data.columns[0]).toMatchObject({ key: 'date', title: 'Sana', type: 'date' }); // user language is Uzbek by default
    expect(t.shop.shopId).toBeTruthy();
  });

  it('report totals match the receipt journal', async () => {
    const { rep } = await scenario();
    const sales = await rep('sales');
    const journal = await rep('journal', 'limit=1000');
    expect(journal.data.rows).toHaveLength(3);
    expect(journal.data.rows.reduce((s: number, x: any) => s + x.total, 0)).toBe(sales.data.totals.revenue);
    expect(journal.meta.total).toBe(3);
    expect((await rep('journal', 'number=1-000001')).data.rows).toHaveLength(1);
  });

  it('sales by product use net quantities and costs; gross profit and margin', async () => {
    const { rep } = await scenario();
    const r = (await rep('products')).data;
    const cola = r.rows.find((x: any) => x.product === 'Cola 1L');
    const bread = r.rows.find((x: any) => x.product === 'Bread');
    expect(cola).toMatchObject({ quantity: 3, revenue: 3_600_000, cost: 2_100_000, grossProfit: 1_500_000, margin: 41.67 });
    expect(bread).toMatchObject({ quantity: 2, revenue: 600_000, cost: 300_000, grossProfit: 300_000, margin: 50 }); // S1 bread was refunded
    expect(r.totals).toMatchObject({ revenue: 4_200_000, cost: 2_400_000, grossProfit: 1_800_000 });
  });

  it('profit summary = revenue - cost of goods sold - write-offs', async () => {
    const { rep } = await scenario();
    const r = (await rep('profit')).data;
    expect(r.totals).toMatchObject({ netRevenue: 4_200_000, cost: 2_400_000, writeOffs: 700_000, grossProfit: 1_100_000 });
    expect(r.totals.margin).toBe(26.19);
  });

  it('categories, cashiers, returns, shifts and promotions', async () => {
    const { t, rep } = await scenario();
    await t.post('/promotions', { name: 'Bread deal', type: 'percent', rules: { percent: 10, productIds: [t.bread.id] } });
    await t.sell([{ productId: t.bread.id, qty: 2 }], [{ method: 'cash', amount: 600_000 }]);

    const cats = (await rep('categories')).data;
    expect(cats.rows[0].category).toBe('-'); // products without a category
    const cashiers = (await rep('cashiers')).data;
    expect(cashiers.rows).toHaveLength(1);
    expect(cashiers.rows[0]).toMatchObject({ receipts: 4, returns: 300_000 });
    const returns = (await rep('returns')).data;
    expect(returns.rows).toHaveLength(1);
    expect(returns.rows[0]).toMatchObject({ reason: 'changed mind', total: 300_000, method: 'cash', saleNumber: '1-000001' });
    const shifts = (await rep('shifts')).data;
    expect(shifts.rows).toHaveLength(1);
    expect(shifts.rows[0]).toMatchObject({ receipts: 4, openingCash: 100_000 });
    const promos = (await rep('promotions')).data;
    expect(promos.rows[0]).toMatchObject({ promotion: 'Bread deal', quantity: 2, discountAmount: 60_000, revenue: 540_000 });
  });

  it('stock balance, stock movement, negative and slow-moving reports', async () => {
    const { t, rep } = await scenario();
    const bal = (await rep('stock')).data;
    const cola = bal.rows.find((x: any) => x.product === 'Cola 1L');
    expect(cola).toMatchObject({ quantity: 96, valueAtCost: 96 * COLA.cost, price: COLA.price, valueAtPrice: 96 * COLA.price });
    expect(bal.totals.quantity).toBe(96 + 98);
    // balance on a past date (before today's trading): everything was received, nothing sold yet
    const past = (await rep('stock', `date=${tashkentDateString(new Date(Date.now() - 2 * 86_400_000))}`)).data;
    expect(past.rows).toHaveLength(0);

    const mv = (await rep('stock-movement')).data;
    expect(mv.rows.find((x: any) => x.product === 'Cola 1L')).toMatchObject({ opening: 0, incoming: 100, outgoing: 4, closing: 96 });
    const todayOnly = (await rep('stock-movement', `from=${tashkentDateString(new Date(Date.now() + 86_400_000))}&to=${tashkentDateString(new Date(Date.now() + 2 * 86_400_000))}`)).data;
    expect(todayOnly.rows.find((x: any) => x.product === 'Cola 1L')).toMatchObject({ opening: 96, incoming: 0, outgoing: 0, closing: 96 });

    await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'lost', post: true, lines: [{ productId: t.cola.id, qty: 100 }] });
    expect((await rep('negative-stock')).data.rows).toEqual([expect.objectContaining({ product: 'Cola 1L', quantity: -4 })]);

    // slow moving: bread sold recently, an old product never sold
    const dusty = await t.product({ name: 'Dusty' });
    await t.receive(t.shop.branchId, t.supplierId, [[dusty.id, 5, 100_000]]);
    const slow = (await rep('slow-moving', 'days=7')).data;
    expect(slow.rows.map((x: any) => x.product)).toEqual(['Dusty']);
    expect(slow.rows[0]).toMatchObject({ quantity: 5, valueAtCost: 500_000, lastSale: '' });
  });

  it('prices report lists products without a price; purchases group by document, supplier and product', async () => {
    const { t, rep } = await scenario();
    await t.product({ name: 'Unpriced' });
    expect((await rep('prices', 'missingOnly=true')).data.rows.map((x: any) => x.product)).toEqual(['Unpriced']);
    expect((await rep('prices')).data.rows).toHaveLength(3);

    const doc = (await rep('purchases')).data;
    expect(doc.rows).toHaveLength(1);
    expect(doc.totals.total).toBe(100 * COLA.cost + 100 * BREAD.cost);
    const sup = (await rep('purchases', 'groupBy=supplier')).data;
    expect(sup.rows[0]).toMatchObject({ receipts: 1, total: 85_000_000 });
    const prod = (await rep('purchases', 'groupBy=product')).data;
    expect(prod.rows.find((x: any) => x.product === 'Cola 1L')).toMatchObject({ quantity: 100, price: COLA.cost, total: 70_000_000 });
  });

  it('supplier balances flag only the part of the debt that is past its payment term', async () => {
    const t = await posCtx();
    const fresh = await t.supplier({ name: 'Fresh debt', paymentTermDays: 30 });
    const old = await t.supplier({ name: 'Old debt', paymentTermDays: 7 });
    const p = await t.product();
    await t.receive(t.shop.branchId, fresh.id, [[p.id, 1, 1_000_000]]);
    const oldReceipt = await t.receive(t.shop.branchId, old.id, [[p.id, 1, 2_000_000]]);
    const { GoodsReceipt } = await import('../src/models/stock');
    await GoodsReceipt.updateOne({ _id: oldReceipt.id, shopId: t.shop.shopId }, { postedAt: new Date(Date.now() - 20 * 86_400_000) });
    await t.post('/supplier-payments', { supplierId: old.id, amount: 500_000, method: 'cash' });
    const r = (await t.get('/reports/suppliers')).body.data;
    expect(r.rows.find((x: any) => x.supplier === 'Fresh debt')).toMatchObject({ balance: 1_000_000, overdue: 0 });
    expect(r.rows.find((x: any) => x.supplier === 'Old debt')).toMatchObject({ balance: 1_500_000, overdue: 1_500_000 });
    expect(r.totals).toMatchObject({ balance: 85_000_000 + 2_500_000, overdue: 1_500_000 });
  });

  it('customer debts with ageing buckets and the loyalty ledger', async () => {
    const { t, cust, rep } = await scenario();
    const l = (await rep('loyalty')).data;
    expect(l.rows[0]).toMatchObject({ customer: 'Reporter', bonusEarned: 54_000, bonusSpent: 0 });
    expect(l.rows[0].bonusBalance).toBe(54_000 - 6_000); // the refunded bread reverses 2 % of 300 000

    await Customer.updateOne({ _id: cust.id, shopId: t.shop.shopId }, { debtBalance: 900_000, debtSince: new Date(Date.now() - 45 * 86_400_000) });
    const c2 = (await t.post('/customers', { fullName: 'Fresh debtor', phone: '+998 90 123 00 01' }, t.cashier.h)).body.data;
    await Customer.updateOne({ _id: c2.id, shopId: t.shop.shopId }, { debtBalance: 100_000, debtSince: new Date(Date.now() - 5 * 86_400_000) });
    const d = (await rep('customer-debts')).data;
    expect(d.rows[0]).toMatchObject({ customer: 'Reporter', debt: 900_000, age0: 0, age31: 900_000, age60: 0 });
    expect(d.rows[1]).toMatchObject({ debt: 100_000, age0: 100_000 });
    expect(d.totals).toMatchObject({ debt: 1_000_000, age0: 100_000, age31: 900_000 });
  });

  it('offline sync report lists offline sales with the delay and conflicts', async () => {
    const { rep } = await scenario();
    const r = (await rep('offline-sync')).data;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ localNumber: 'L-77', total: 600_000, conflicts: 0 });
    expect(r.rows[0].delayMin).toBeGreaterThanOrEqual(23 * 60);
  });

  it('fiscal report counts fiscalized receipts, gaps and fiscal errors', async () => {
    const { rep } = await scenario();
    const r = (await rep('fiscal')).data;
    expect(r.totals).toMatchObject({ receipts: 3, fiscalized: 0, notFiscalized: 3, fiscalErrors: 0 });
  });
});

describe('report exports (spec 11)', () => {
  it('exports Excel with translated headers, money in major units and a totals row', async () => {
    const { t } = await scenario();
    await t.patch('/auth/language', { language: 'ru' }, t.A);
    const res = await api().get(`${P}/reports/sales?format=xlsx`).set(t.A).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/sales-\d{4}-\d{2}-\d{2}_/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('Дата');
    expect(ws.getRow(1).getCell(3).value).toBe('Выручка');
    const last = ws.getRow(ws.rowCount);
    expect(last.getCell(1).value).toBe('Итого');
    expect(last.getCell(3).value).toBe(45_000); // 4 500 000 tiyin = 45 000 so'm
  });

  it('exports PDF', async () => {
    const { t } = await scenario();
    const res = await api().get(`${P}/reports/products?format=pdf`).set(t.A).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('who sees which report (spec 2.1, 11.2)', () => {
  it('cashiers see no reports; storekeepers only stock reports; managers not the admin-only ones', async () => {
    const { t } = await scenario();
    const keeper = await t.staff('storekeeper');
    const get = (key: string, h: any) => t.get(`/reports/${key}`, h).then((r) => r.status);
    expect(await get('sales', t.cashier.h)).toBe(403);
    expect(await get('stock', t.cashier.h)).toBe(403);
    expect((await t.get('/reports/dashboard', t.cashier.h)).status).toBe(403);
    expect(await get('stock', keeper.h)).toBe(200);
    expect(await get('stock-movement', keeper.h)).toBe(200);
    expect(await get('negative-stock', keeper.h)).toBe(200);
    expect(await get('purchases', keeper.h)).toBe(200);
    expect(await get('sales', keeper.h)).toBe(403);
    expect(await get('profit', keeper.h)).toBe(403);
    expect(await get('sales', t.manager.h)).toBe(200);
    expect(await get('journal', t.manager.h)).toBe(200);
    for (const adminOnly of ['promotions', 'prices', 'suppliers', 'loyalty', 'profit', 'fiscal', 'offline-sync']) expect(await get(adminOnly, t.manager.h), adminOnly).toBe(403);
    expect(await get('profit', t.A)).toBe(200);
    expect((await t.get('/reports', t.manager.h)).body.data.map((r: any) => r.key)).not.toContain('profit');
    expect((await t.get('/reports/nope')).status).toBe(404);
  });

  it('branch managers only see their own branches', async () => {
    const { t } = await scenario();
    const b2 = await t.branch('Other branch');
    expect((await t.get(`/reports/sales?branchId=${b2}`, t.manager.h)).status).toBe(403);
    expect((await t.get(`/reports/sales?branchId=${t.shop.branchId}`, t.manager.h)).status).toBe(200);
    // another branch's trading never leaks into the manager's totals
    const cashier2 = await t.staff('cashier', { branchIds: [b2], pin: '4321' });
    const term2 = (await t.post('/terminals', { name: 'Kassa B2', branchId: b2 })).body.data;
    await t.receive(b2, t.supplierId, [[t.cola.id, 10, 700_000]]);
    await t.put('/prices', { changes: [{ productId: t.cola.id, branchId: b2, price: 1_300_000 }] });
    const sh = (await t.post('/shifts/open', { terminalId: term2.id, openingCash: 0 }, cashier2.h)).body.data;
    await t.post('/sales', { clientRequestId: randomUUID(), terminalId: term2.id, shiftId: sh.id, lines: [{ productId: t.cola.id, qty: 1 }], payments: [{ method: 'cash', amount: 1_300_000 }] }, cashier2.h);
    const mgr = (await t.get('/reports/sales', t.manager.h)).body.data.totals;
    const admin = (await t.get('/reports/sales', t.A)).body.data.totals;
    expect(mgr.revenue).toBe(4_500_000);
    expect(admin.revenue).toBe(5_800_000);
    expect((await t.get('/reports/sales', cashier2.h)).status).toBe(403);
  });

  it('shop B never sees data of shop A in any report', async () => {
    const a = await scenario();
    const b = await posCtx({ sa: a.t.sa });
    for (const key of ['sales', 'products', 'cashiers', 'shifts', 'returns', 'stock', 'stock-movement', 'purchases', 'journal', 'profit', 'loyalty', 'customer-debts']) {
      const r = (await b.get(`/reports/${key}`)).body.data;
      const text = JSON.stringify(r.rows);
      expect(text, key).not.toContain('Reporter');
      if (['sales', 'journal'].includes(key)) expect(r.totals?.revenue ?? 0).toBe(0);
    }
  });
});

describe('dashboard (spec 11.1)', () => {
  it('compares today with yesterday and last week, charts and splits payments', async () => {
    const { t } = await scenario();
    const d = (await t.get('/reports/dashboard')).body.data;
    expect(d.today).toMatchObject({ receipts: 2, revenue: 3_600_000, averageReceipt: 1_950_000 });
    expect(d.today.grossProfit).toBe(1_500_000);
    expect(d.yesterday).toMatchObject({ receipts: 1, revenue: 600_000 });
    expect(d.sameDayLastWeek.receipts).toBe(0);
    expect(d.chart.map((c: any) => c.revenue).reduce((a: number, b: number) => a + b, 0)).toBe(4_500_000);
    expect(d.paymentSplit).toEqual(expect.arrayContaining([{ method: 'cash', amount: 3_300_000 }, { method: 'card', amount: 1_200_000 }]));
    expect(d.topProductsByRevenue[0]).toMatchObject({ name: 'Cola 1L', revenue: 3_600_000, quantity: 3 });
    expect(d.topProductsByQuantity[0].name).toBe('Cola 1L');
    expect(d.branchComparison).toHaveLength(1);
    expect(d.byHour.reduce((a: number, h: any) => a + h.receipts, 0)).toBe(3);
    expect(d.byWeekday.reduce((a: number, h: any) => a + h.receipts, 0)).toBe(3);
    expect(d.live).toMatchObject({ openShifts: 1, lowStock: 0, negativeStock: 0, supplierDebt: 85_000_000, customerDebt: 0 });
  });

  it('shows queued offline receipts reported by the POS and online terminals', async () => {
    const { t } = await scenario();
    await t.put('/pos/status', { terminalId: t.term.id, pendingOffline: 4 }, t.cashier.h);
    const d = (await t.get('/reports/dashboard')).body.data;
    expect(d.live.unsentOfflineReceipts).toBe(4);
    expect(await Stock.countDocuments({ shopId: t.shop.shopId })).toBe(2);
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(3);
    expect(bearer('x')).toBeTruthy();
  });
});
