import { beforeEach, describe, expect, it } from 'vitest';
import { events, type DomainEvent } from '../src/lib/events';
import { Shop } from '../src/models/core';
import { Stock, StockMovement, Supplier } from '../src/models/stock';
import { P, api, bearer, login } from './helpers';
import { setup } from './shopCtx';

/** The ledger invariant of the spec: stock always equals the sum of its movements. */
async function assertLedgerMatchesStock(shopId: string) {
  const stocks = await Stock.find({ shopId }).lean();
  for (const s of stocks) {
    const agg = await StockMovement.aggregate([
      { $match: { shopId: s.shopId, branchId: s.branchId, productId: s.productId } },
      { $group: { _id: null, q: { $sum: '$quantity' } } },
    ]);
    expect(Math.round((agg[0]?.q ?? 0) * 1000) / 1000, `product ${s.productId}`).toBe(s.quantity);
  }
}

const captured: DomainEvent[] = [];
beforeEach(() => {
  captured.length = 0;
  events.clear();
  events.on((e) => void captured.push(e));
});

describe('goods receipts (spec 5.8)', () => {
  it('draft does nothing; posting adds stock, average cost and supplier debt', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const draft = await t.post('/goods-receipts', { supplierId: sup.id, branchId: t.shop.branchId, invoiceNo: 'INV-1', invoiceDate: '2026-11-01', lines: [{ productId: p.id, qty: 10, cost: 100_000 }] });
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({ status: 'draft', total: 1_000_000, number: 'GR-000001' });
    expect(draft.body.data.lines[0].productName).toBe(p.name);
    expect((await t.stockOf(p.id)).quantity).toBe(0);

    const posted = await t.post(`/goods-receipts/${draft.body.data.id}/post`, {});
    expect(posted.body.data.status).toBe('posted');
    expect(await t.stockOf(p.id)).toEqual({ quantity: 10, avgCost: 100_000 });
    expect((await Supplier.findOne({ shopId: t.shop.shopId, _id: sup.id }))!.balance).toBe(1_000_000);
    expect(captured.map((e) => e.name)).toContain('goods_receipt.posted');
  });

  it('recalculates the weighted average cost per branch on every receipt', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 100_000]]);
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 200_000]]);
    expect(await t.stockOf(p.id)).toEqual({ quantity: 20, avgCost: 150_000 });
    await t.receive(t.shop.branchId, sup.id, [[p.id, 5, 100_000]]);
    expect(await t.stockOf(p.id)).toEqual({ quantity: 25, avgCost: 140_000 }); // (20*150k+5*100k)/25
    // another branch has its own cost
    const b2 = await t.branch('B2');
    await t.receive(b2, sup.id, [[p.id, 4, 500_000]]);
    expect(await t.stockOf(p.id, b2)).toEqual({ quantity: 4, avgCost: 500_000 });
    expect((await t.stockOf(p.id)).avgCost).toBe(140_000);
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('a posted receipt cannot be edited, re-posted or deleted; double post is rejected', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const r = await t.receive(t.shop.branchId, sup.id, [[p.id, 3, 1000]]);
    const again = await t.post(`/goods-receipts/${r.id}/post`, {});
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('DOCUMENT_POSTED');
    const edit = await t.patch(`/goods-receipts/${r.id}`, { note: 'x' });
    expect(edit.body.error.code).toBe('DOCUMENT_EDIT_FORBIDDEN');
    expect((await t.stockOf(p.id)).quantity).toBe(3);
  });

  it('two simultaneous posts of the same draft apply the stock exactly once', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const d = await t.post('/goods-receipts', { supplierId: sup.id, branchId: t.shop.branchId, lines: [{ productId: p.id, qty: 7, cost: 5000 }] });
    const results = await Promise.all([1, 2, 3].map(() => t.post(`/goods-receipts/${d.body.data.id}/post`, {})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await t.stockOf(p.id)).quantity).toBe(7);
    expect((await Supplier.findOne({ shopId: t.shop.shopId, _id: sup.id }))!.balance).toBe(35_000);
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('many concurrent receipts of one product never lose an update', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    await Promise.all(Array.from({ length: 12 }, () => t.receive(t.shop.branchId, sup.id, [[p.id, 2.5, 1000]])));
    expect((await t.stockOf(p.id)).quantity).toBe(30);
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('cancelling a posted receipt reverses stock and supplier debt with a reason', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const r = await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 2000]]);
    expect((await t.post(`/goods-receipts/${r.id}/cancel`, {})).status).toBe(400); // reason required
    const c = await t.post(`/goods-receipts/${r.id}/cancel`, { reason: 'wrong invoice' });
    expect(c.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'wrong invoice' });
    expect((await t.stockOf(p.id)).quantity).toBe(0);
    expect((await Supplier.findOne({ shopId: t.shop.shopId, _id: sup.id }))!.balance).toBe(0);
    const types = (await StockMovement.find({ shopId: t.shop.shopId }).sort('createdAt')).map((m) => m.type);
    expect(types).toEqual(['goods_receipt', 'goods_receipt_reversal']);
    expect((await t.post(`/goods-receipts/${r.id}/cancel`, { reason: 'again' })).body.error.code).toBe('DOCUMENT_CANCELLED');
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('locks the shop currency after the first posted document', async () => {
    const t = await setup();
    expect((await Shop.findById(t.shop.shopId))!.currencyLocked).toBe(false);
    const sup = await t.supplier();
    const p = await t.product();
    await t.receive(t.shop.branchId, sup.id, [[p.id, 1, 100]]);
    expect((await Shop.findById(t.shop.shopId))!.currencyLocked).toBe(true);
    const r = await t.patch('/settings', { currency: 'USD' });
    expect(r.body.error.code).toBe('CURRENCY_LOCKED');
  });

  it('validates lines, products, suppliers and branches of the shop', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const base = { supplierId: sup.id, branchId: t.shop.branchId, lines: [{ productId: p.id, qty: 1, cost: 1 }] };
    expect((await t.post('/goods-receipts', { ...base, lines: [] })).status).toBe(400);
    expect((await t.post('/goods-receipts', { ...base, lines: [{ productId: p.id, qty: 0, cost: 1 }] })).status).toBe(400);
    expect((await t.post('/goods-receipts', { ...base, lines: [{ productId: p.id, qty: 1.0005, cost: 1 }] })).status).toBe(400);
    expect((await t.post('/goods-receipts', { ...base, lines: [{ productId: p.id, qty: 1, cost: 1.5 }] })).status).toBe(400);
    expect((await t.post('/goods-receipts', { ...base, supplierId: '64b000000000000000000000' })).body.error.code).toBe('SUPPLIER_NOT_FOUND');
    expect((await t.post('/goods-receipts', { ...base, lines: [{ productId: '64b000000000000000000000', qty: 1, cost: 1 }] })).body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('supports weighed quantities with 3 decimals', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product({ unit: 'kg', isWeighted: true });
    await t.receive(t.shop.branchId, sup.id, [[p.id, 12.345, 8000]]);
    await t.receive(t.shop.branchId, sup.id, [[p.id, 0.655, 8000]]);
    expect((await t.stockOf(p.id)).quantity).toBe(13);
  });
});

describe('suppliers, payments and statements (spec 5.7)', () => {
  it('balance = purchases - payments - returns; partial payments; statement with opening/closing', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const r = await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 100_000]]); // owes 1 000 000
    const pay1 = await t.post('/supplier-payments', { supplierId: sup.id, amount: 300_000, method: 'cash', comment: 'part 1' });
    expect(pay1.body.data.balance).toBe(700_000);
    await t.post('/supplier-payments', { supplierId: sup.id, amount: 200_000, method: 'bank_transfer', paidAt: new Date(Date.now() + 1000).toISOString() });
    const ret = await t.post('/supplier-returns', { supplierId: sup.id, branchId: t.shop.branchId, goodsReceiptId: r.id, reason: 'damaged', post: true, lines: [{ productId: p.id, qty: 1, cost: 100_000 }] });
    expect(ret.status).toBe(201);

    const supplier = (await t.get(`/suppliers/${sup.id}`)).body.data;
    expect(supplier.balance).toBe(400_000);
    const st = (await t.get(`/suppliers/${sup.id}/statement`)).body.data;
    expect(st.openingBalance).toBe(0);
    expect(st.closingBalance).toBe(400_000);
    expect(st.entries.map((e: any) => e.type)).toEqual(expect.arrayContaining(['purchase', 'payment', 'return']));
    expect(st.entries.at(-1).balance).toBe(400_000);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const after = (await t.get(`/suppliers/${sup.id}/statement?from=${future}`)).body.data;
    expect(after.openingBalance).toBe(400_000);
    expect(after.entries).toHaveLength(0);
  });

  it('supplier list can show only debtors; storekeepers see suppliers but cannot manage or pay', async () => {
    const t = await setup();
    const s1 = await t.supplier({ name: 'Owed' });
    await t.supplier({ name: 'Clean' });
    const p = await t.product();
    await t.receive(t.shop.branchId, s1.id, [[p.id, 1, 5000]]);
    expect((await t.get('/suppliers?debtOnly=true')).body.data.map((s: any) => s.name)).toEqual(['Owed']);
    const store = await t.staff('storekeeper');
    expect((await t.get('/suppliers', store.h)).status).toBe(200);
    expect((await t.post('/suppliers', { name: 'Nope' }, store.h)).status).toBe(403);
    expect((await t.post('/supplier-payments', { supplierId: s1.id, amount: 100, method: 'cash' }, store.h)).status).toBe(403);
    const mgr = await t.staff('branch_manager');
    expect((await t.post('/supplier-payments', { supplierId: s1.id, amount: 100, method: 'cash' }, mgr.h)).status).toBe(403); // optional permission
    await t.patch(`/users/${mgr.id}`, { permissions: ['suppliers.pay'] });
    const mgr2 = await login(mgr.login, 'password123');
    expect((await t.post('/supplier-payments', { supplierId: s1.id, amount: 100, method: 'cash' }, bearer(mgr2.token))).status).toBe(201);
  });
});

describe('returns to supplier (spec 5.9)', () => {
  it('cannot return more than received (cumulative); posting lowers stock and debt', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const r = await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 1000]]);
    const make = (qty: number) => t.post('/supplier-returns', { supplierId: sup.id, branchId: t.shop.branchId, goodsReceiptId: r.id, reason: 'defect', post: true, lines: [{ productId: p.id, qty, cost: 1000 }] });
    expect((await make(6)).status).toBe(201);
    const over = await make(5);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('RETURN_EXCEEDS_RECEIVED');
    expect((await t.stockOf(p.id)).quantity).toBe(4); // the failed post changed nothing
    expect((await make(4)).status).toBe(201);
    expect((await t.stockOf(p.id)).quantity).toBe(0);
    expect((await Supplier.findOne({ shopId: t.shop.shopId, _id: sup.id }))!.balance).toBe(0);
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('can be created freely and cancelled with a reversal', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    await t.receive(t.shop.branchId, sup.id, [[p.id, 5, 1000]]);
    const ret = await t.post('/supplier-returns', { supplierId: sup.id, branchId: t.shop.branchId, reason: 'expired', post: true, lines: [{ productId: p.id, qty: 2, cost: 1000 }] });
    expect((await t.stockOf(p.id)).quantity).toBe(3);
    await t.post(`/supplier-returns/${ret.body.data.id}/cancel`, { reason: 'mistake' });
    expect((await t.stockOf(p.id)).quantity).toBe(5);
    expect((await Supplier.findOne({ shopId: t.shop.shopId, _id: sup.id }))!.balance).toBe(5000);
  });
});

describe('transfers between branches (spec 5.10)', () => {
  it('send removes stock from the source, receive adds it to the destination with its cost', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const b2 = await t.branch('B2');
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 100_000]]);
    await t.receive(b2, sup.id, [[p.id, 10, 200_000]]);

    const tr = await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: b2, lines: [{ productId: p.id, qty: 4 }] });
    expect(tr.status).toBe(201);
    expect(tr.body.data.number).toBe('TR-000001');
    expect((await t.stockOf(p.id)).quantity).toBe(10); // draft changes nothing
    await t.post(`/transfers/${tr.body.data.id}/send`, {});
    expect((await t.stockOf(p.id)).quantity).toBe(6);
    expect((await t.stockOf(p.id, b2)).quantity).toBe(10); // still in transit
    const rec = await t.post(`/transfers/${tr.body.data.id}/receive`, {});
    expect(rec.body.data).toMatchObject({ status: 'received', discrepancy: false });
    expect(await t.stockOf(p.id, b2)).toEqual({ quantity: 14, avgCost: Math.round((10 * 200_000 + 4 * 100_000) / 14) });
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('receiving fewer units than sent flags a discrepancy; the shortfall is not added', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const b2 = await t.branch('B2');
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 1000]]);
    const tr = (await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: b2, lines: [{ productId: p.id, qty: 5 }] })).body.data;
    await t.post(`/transfers/${tr.id}/send`, {});
    const rec = await t.post(`/transfers/${tr.id}/receive`, { lines: [{ productId: p.id, qtyReceived: 3 }], note: '2 broken in transit' });
    expect(rec.body.data).toMatchObject({ discrepancy: true, receiveNote: '2 broken in transit' });
    expect(rec.body.data.lines[0]).toMatchObject({ qtySent: 5, qtyReceived: 3 });
    expect((await t.stockOf(p.id, b2)).quantity).toBe(3);
    expect((await t.stockOf(p.id)).quantity).toBe(5);
  });

  it('cannot send to the same branch, receive twice, or cancel after receiving; cancel while in transit returns stock', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const b2 = await t.branch('B2');
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 1000]]);
    expect((await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: t.shop.branchId, lines: [{ productId: p.id, qty: 1 }] })).body.error.code).toBe('SAME_BRANCH');
    const tr = (await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: b2, lines: [{ productId: p.id, qty: 6 }] })).body.data;
    expect((await t.post(`/transfers/${tr.id}/receive`, {})).body.error.code).toBe('INVALID_STATE'); // not sent yet
    await t.post(`/transfers/${tr.id}/send`, {});
    expect((await t.post(`/transfers/${tr.id}/send`, {})).status).toBe(422);
    await t.post(`/transfers/${tr.id}/cancel`, { reason: 'changed my mind' });
    expect((await t.stockOf(p.id)).quantity).toBe(10);

    const tr2 = (await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: b2, lines: [{ productId: p.id, qty: 2 }] })).body.data;
    await t.post(`/transfers/${tr2.id}/send`, {});
    await t.post(`/transfers/${tr2.id}/receive`, {});
    expect((await t.post(`/transfers/${tr2.id}/receive`, {})).status).toBe(422);
    expect((await t.post(`/transfers/${tr2.id}/cancel`, { reason: 'late' })).status).toBe(422);
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('branch staff: sender and receiver need access to their own side only', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const b2 = await t.branch('B2');
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 1000]]);
    const keeperA = await t.staff('storekeeper');
    const keeperB = await t.staff('storekeeper', { branchIds: [b2] });
    const tr = (await t.post('/transfers', { fromBranchId: t.shop.branchId, toBranchId: b2, lines: [{ productId: p.id, qty: 3 }] }, keeperA.h)).body.data;
    expect((await t.post(`/transfers/${tr.id}/send`, {}, keeperB.h)).status).toBe(403); // not their branch
    expect((await t.post(`/transfers/${tr.id}/send`, {}, keeperA.h)).status).toBe(200);
    expect((await t.post(`/transfers/${tr.id}/receive`, {}, keeperA.h)).status).toBe(403); // sender cannot receive
    expect((await t.post(`/transfers/${tr.id}/receive`, {}, keeperB.h)).status).toBe(200);
    // each storekeeper sees the transfer in their list; an unrelated third branch does not
    const b3 = await t.branch('B3');
    const keeperC = await t.staff('storekeeper', { branchIds: [b3] });
    expect((await t.get('/transfers', keeperB.h)).body.data).toHaveLength(1);
    expect((await t.get('/transfers', keeperC.h)).body.data).toHaveLength(0);
    expect((await t.get(`/transfers/${tr.id}`, keeperC.h)).status).toBe(404);
  });
});

describe('write-offs (spec 5.10)', () => {
  it('values the loss at average cost and needs a valid reason', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 100_000], [p.id, 10, 200_000]]);
    expect((await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'because', lines: [{ productId: p.id, qty: 1 }] })).status).toBe(400);
    const w = await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'expired', comment: 'milk', post: true, lines: [{ productId: p.id, qty: 4 }] });
    expect(w.status).toBe(201);
    expect(w.body.data).toMatchObject({ status: 'posted', total: 4 * 150_000 });
    expect((await t.stockOf(p.id)).quantity).toBe(16);
    expect((await t.stockOf(p.id)).avgCost).toBe(150_000); // average unchanged by outgoing stock
    await t.post(`/write-offs/${w.body.data.id}/cancel`, { reason: 'entered twice' });
    expect((await t.stockOf(p.id)).quantity).toBe(20);
    await assertLedgerMatchesStock(t.shop.shopId);
  });
});

describe('negative stock policy (spec 5.10)', () => {
  it('allowed by default: stock goes below zero and shows in the negative report with an event', async () => {
    const t = await setup();
    const p = await t.product();
    const w = await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'lost', post: true, lines: [{ productId: p.id, qty: 3 }] });
    expect(w.status).toBe(201);
    expect((await t.stockOf(p.id)).quantity).toBe(-3);
    const neg = (await t.get('/stock/negative')).body.data;
    expect(neg).toHaveLength(1);
    expect(neg[0]).toMatchObject({ productId: p.id, quantity: -3 });
    expect(captured.some((e) => e.name === 'stock.negative')).toBe(true);
  });

  it('blocked by the admin: the document is refused as a whole and nothing changes', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const [p1, p2] = [await t.product(), await t.product()];
    await t.receive(t.shop.branchId, sup.id, [[p1.id, 10, 1000], [p2.id, 1, 1000]]);
    await t.patch('/settings', { allowNegativeStock: false });
    const w = await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'damaged', post: true, lines: [{ productId: p1.id, qty: 5 }, { productId: p2.id, qty: 2 }] });
    expect(w.status).toBe(422);
    expect(w.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(w.body.error.details).toMatchObject({ productId: p2.id, available: 1, requested: 2 });
    expect((await t.stockOf(p1.id)).quantity).toBe(10); // first line was rolled back with the transaction
    expect((await t.stockOf(p2.id)).quantity).toBe(1);
    expect(await StockMovement.countDocuments({ shopId: t.shop.shopId, type: 'write_off' })).toBe(0);
    // within the available quantity it works
    expect((await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'damaged', post: true, lines: [{ productId: p1.id, qty: 10 }] })).status).toBe(201);
    await assertLedgerMatchesStock(t.shop.shopId);
  });
});

describe('stock counts (spec 5.10)', () => {
  it('prefills the sheet, adjusts to the counted quantity and records differences', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const cat = (await t.post('/categories', { name: 'Dairy' })).body.data;
    const [milk, cheese, bread] = [await t.product({ categoryId: cat.id }), await t.product({ categoryId: cat.id }), await t.product()];
    await t.receive(t.shop.branchId, sup.id, [[milk.id, 10, 5000], [cheese.id, 5, 9000], [bread.id, 8, 2000]]);

    const c = (await t.post('/stock-counts', { branchId: t.shop.branchId, categoryId: cat.id })).body.data;
    expect(c.lines.map((l: any) => l.productId).sort()).toEqual([milk.id, cheese.id].sort()); // only the category
    await api().put(`${P}/stock-counts/${c.id}/lines`).set(t.A).send({ lines: [{ productId: milk.id, counted: 8 }, { productId: cheese.id, counted: 5 }] }).expect(200);
    const view = (await t.get(`/stock-counts/${c.id}`)).body.data;
    expect(view.lines.find((l: any) => l.productId === milk.id)).toMatchObject({ expected: 10, counted: 8, diff: -2 });

    // a sale/receipt between counting and posting does not break the adjustment: result == counted
    await t.receive(t.shop.branchId, sup.id, [[milk.id, 1, 5000]]);
    const posted = await t.post(`/stock-counts/${c.id}/post`, {});
    expect(posted.body.data.status).toBe('posted');
    expect(posted.body.data.lines.find((l: any) => l.productId === milk.id)).toMatchObject({ expected: 11, counted: 8, diff: -3 });
    expect((await t.stockOf(milk.id)).quantity).toBe(8);
    expect((await t.stockOf(cheese.id)).quantity).toBe(5);
    expect((await t.stockOf(bread.id)).quantity).toBe(8); // out of scope
    expect(await StockMovement.countDocuments({ shopId: t.shop.shopId, type: 'count_adjustment' })).toBe(1);
    expect((await t.post(`/stock-counts/${c.id}/post`, {})).body.error.code).toBe('DOCUMENT_POSTED');
    await assertLedgerMatchesStock(t.shop.shopId);
  });

  it('uncounted products stay unchanged unless zeroUncounted is set; scanned extras are added', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const [a, b, extra] = [await t.product(), await t.product(), await t.product()];
    await t.receive(t.shop.branchId, sup.id, [[a.id, 4, 1000], [b.id, 6, 1000]]);
    const c = (await t.post('/stock-counts', { branchId: t.shop.branchId })).body.data;
    await api().put(`${P}/stock-counts/${c.id}/lines`).set(t.A).send({ lines: [{ productId: a.id, counted: 4 }, { productId: extra.id, counted: 2 }] }).expect(200);
    await t.post(`/stock-counts/${c.id}/post`, { zeroUncounted: true });
    expect((await t.stockOf(a.id)).quantity).toBe(4);
    expect((await t.stockOf(b.id)).quantity).toBe(0);
    expect((await t.stockOf(extra.id)).quantity).toBe(2);
    await assertLedgerMatchesStock(t.shop.shopId);
  });
});

describe('stock queries (spec 5.10)', () => {
  it('lists balances valued at average cost and at selling price, with totals; stock card has running balance', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product({ name: 'Valued' });
    await t.receive(t.shop.branchId, sup.id, [[p.id, 10, 100_000]]);
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 150_000 }] });
    const r = await t.get(`/stock?branchId=${t.shop.branchId}`);
    expect(r.body.data[0]).toMatchObject({ name: 'Valued', quantity: 10, avgCost: 100_000, price: 150_000, valueAtCost: 1_000_000, valueAtPrice: 1_500_000 });
    expect(r.body.meta.totals).toMatchObject({ quantity: 10, valueAtCost: 1_000_000, valueAtPrice: 1_500_000 });

    await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'lost', post: true, lines: [{ productId: p.id, qty: 3 }] });
    const card = (await t.get(`/stock/movements?productId=${p.id}&branchId=${t.shop.branchId}`)).body.data;
    expect(card.map((m: any) => [m.type, m.quantity, m.balanceAfter])).toEqual([['write_off', -3, 7], ['goods_receipt', 10, 10]]);
    expect(card[0].productName).toBe('Valued');
  });

  it('low-stock list and product filters by stock status; min stock fires an event once', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const [a, b, c] = [await t.product({ name: 'Low' }), await t.product({ name: 'Fine' }), await t.product({ name: 'Never' })];
    await t.receive(t.shop.branchId, sup.id, [[a.id, 10, 1000], [b.id, 10, 1000]]);
    await t.put('/stock/min-stock', { branchId: t.shop.branchId, items: [{ productId: a.id, minStock: 5 }, { productId: b.id, minStock: 2 }] });
    expect((await t.get('/stock/low')).body.data).toHaveLength(0);
    captured.length = 0;
    await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'lost', post: true, lines: [{ productId: a.id, qty: 6 }] });
    expect(captured.filter((e) => e.name === 'stock.low')).toHaveLength(1);
    await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'lost', post: true, lines: [{ productId: a.id, qty: 1 }] });
    expect(captured.filter((e) => e.name === 'stock.low')).toHaveLength(1); // already low: no repeat
    expect((await t.get('/stock/low')).body.data.map((r: any) => r.name)).toEqual(['Low']);

    const names = async (qs: string) => (await t.get(`/products?branchId=${t.shop.branchId}&${qs}`)).body.data.map((p: any) => p.name).sort();
    expect(await names('stockStatus=low')).toEqual(['Low']);
    expect(await names('stockStatus=in')).toEqual(['Fine', 'Low']);
    expect(await names('stockStatus=out')).toEqual(['Never']);
    expect(c.id).toBeTruthy();
  });

  it('branch staff only see stock of their own branches', async () => {
    const t = await setup();
    const sup = await t.supplier();
    const p = await t.product();
    const b2 = await t.branch('B2');
    await t.receive(b2, sup.id, [[p.id, 5, 1000]]);
    const keeper = await t.staff('storekeeper');
    expect((await t.get(`/stock?branchId=${b2}`, keeper.h)).status).toBe(403);
    expect((await t.get(`/stock/movements?branchId=${b2}`, keeper.h)).status).toBe(403);
    expect((await t.get(`/stock?branchId=${t.shop.branchId}`, keeper.h)).status).toBe(200);
    expect((await t.get('/goods-receipts', keeper.h)).body.data).toHaveLength(0); // receipt belongs to B2
    const cashier = await t.staff('cashier');
    expect((await t.get(`/stock?branchId=${t.shop.branchId}`, cashier.h)).status).toBe(403);
  });
});

describe('stock tenant isolation', () => {
  it("shop B cannot see or post against shop A's documents, suppliers or stock", async () => {
    const a = await setup();
    const b = await setup({}, a.sa);
    const sup = await a.supplier();
    const p = await a.product();
    const r = await a.receive(a.shop.branchId, sup.id, [[p.id, 5, 1000]]);
    for (const path of [`/goods-receipts/${r.id}`, `/suppliers/${sup.id}`, `/suppliers/${sup.id}/statement`]) {
      expect((await b.get(path)).status, path).toBe(404);
    }
    expect((await b.post(`/goods-receipts/${r.id}/cancel`, { reason: 'hack attempt' })).status).toBe(404);
    expect((await b.post('/goods-receipts', { supplierId: sup.id, branchId: b.shop.branchId, lines: [{ productId: p.id, qty: 1, cost: 1 }] })).body.error.code).toBe('SUPPLIER_NOT_FOUND');
    expect((await b.post('/supplier-payments', { supplierId: sup.id, amount: 1, method: 'cash' })).status).toBe(404);
    expect((await b.get(`/stock?branchId=${a.shop.branchId}`)).status).toBe(404);
    expect((await b.get('/goods-receipts')).body.data).toHaveLength(0);
    expect((await a.stockOf(p.id)).quantity).toBe(5);
  });
});
