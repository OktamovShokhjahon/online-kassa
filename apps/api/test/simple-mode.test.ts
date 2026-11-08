/**
 * The warehouse ("Ombor") switched off (KASS_INVENTORY unset, the default outside tests):
 * products are sold without counting quantities and profit comes from each product's cost price.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { events } from '../src/lib/events';
import { Shop } from '../src/models/core';
import { posCtx } from './posCtx';

const ok = (r: { status: number; body: any }, status = 200) => {
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

beforeEach(() => { process.env.KASS_INVENTORY = 'false'; });
afterEach(() => { process.env.KASS_INVENTORY = 'true'; });

describe('selling without the warehouse', () => {
  it('sells a product that was never received, without stock warnings or alerts, at its cost price', async () => {
    const t = await posCtx();
    // the shop even forbids negative stock: with the warehouse off quantities are not checked
    await Shop.updateOne({ _id: t.shop.shopId }, { 'settings.allowNegativeStock': false });
    const p = ok(await t.post('/products', { name: 'Lavash', costPrice: 400_000, prices: [{ branchId: t.shop.branchId, price: 600_000 }] }), 201);
    expect(p.costPrice).toBe(400_000);

    const seen: string[] = [];
    events.on((e) => { if (e.name.startsWith('stock.')) seen.push(e.name); });
    const sale = ok(await t.sell([{ productId: p.id, qty: 3 }], [{ method: 'cash', amount: 1_800_000 }]), 201);
    events.clear();
    expect(sale.total).toBe(1_800_000);
    expect(sale.warnings ?? []).toEqual([]);
    expect(seen).toEqual([]);

    const dash = ok(await t.get('/reports/dashboard'));
    // 3 x (6 000 - 4 000) = 6 000 so'm profit, on top of nothing else sold today
    expect(dash.today.grossProfit).toBe(3 * 200_000);
  });

  it('hides the warehouse reports', async () => {
    const t = await posCtx({ openShift: false });
    const keys = ok(await t.get('/reports')).map((r: any) => r.key);
    expect(keys).toContain('profit');
    expect(keys).toContain('sales');
    for (const k of ['stock', 'stock-movement', 'negative-stock', 'slow-moving', 'purchases', 'suppliers']) expect(keys).not.toContain(k);
  });
});

describe('deleting a product', () => {
  it('removes a never-used product completely, prices included', async () => {
    const t = await posCtx({ openShift: false });
    const p = ok(await t.post('/products', { name: 'Typo product', barcodes: ['2000999000017'], prices: [{ branchId: t.shop.branchId, price: 100_000 }] }), 201);
    ok(await t.api().delete(`${t.P}/products/${p.id}`).set(t.A));
    expect((await t.get(`/products/${p.id}`)).status).toBe(404);
    expect(ok(await t.get('/products?q=Typo'))).toEqual([]);
    // the barcode is free again
    ok(await t.post('/products', { name: 'Right product', barcodes: ['2000999000017'] }), 201);
  });

  it('takes a sold product out of the catalog but keeps its sales; its barcode can be reused', async () => {
    const t = await posCtx();
    const sale = ok(await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: 1_200_000 }]), 201);
    const code = t.cola.barcodes[0];
    ok(await t.api().delete(`${t.P}/products/${t.cola.id}`).set(t.A));

    expect(ok(await t.get('/products?limit=100')).map((x: any) => x.id)).not.toContain(t.cola.id);
    expect((await t.get(`/products/by-barcode/${code}`)).status).toBe(404);
    // the till cannot sell it any more
    expect((await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: 1_200_000 }])).body.error.code).toBe('PRODUCT_INACTIVE');
    // history is intact
    expect(ok(await t.get(`/sales/${sale.id}`)).lines[0].name).toBe('Cola 1L');
    // deleting twice is a 404, and the code can be given to a new product
    expect((await t.api().delete(`${t.P}/products/${t.cola.id}`).set(t.A)).status).toBe(404);
    ok(await t.post('/products', { name: 'New cola', barcodes: [code] }), 201);
    // cashiers cannot delete
    expect((await t.api().delete(`${t.P}/products/${t.bread.id}`).set(t.cashier.h)).status).toBe(403);
  });
});

describe('cost price', () => {
  it('is set by the shop admin only and never shown to cashiers', async () => {
    const t = await posCtx({ openShift: false });
    const p = ok(await t.post('/products', { name: 'Choy', costPrice: 900_000 }), 201);
    expect(ok(await t.get(`/products/${p.id}`)).costPrice).toBe(900_000);
    expect(ok(await t.get(`/products/${p.id}`, t.cashier.h)).costPrice).toBeUndefined();
    expect(ok(await t.get('/products?q=Choy', t.cashier.h))[0].costPrice).toBeUndefined();

    // a manager allowed to edit products still cannot set the cost price
    const mgr = await t.staff('branch_manager', { pin: '9898', permissions: ['products.manage'] });
    expect((await t.patch(`/products/${p.id}`, { costPrice: 1 }, mgr.h)).status).toBe(403);
    expect(ok(await t.patch(`/products/${p.id}`, { name: 'Choy 100g', costPrice: 900_000 }, mgr.h)).name).toBe('Choy 100g');
    expect((await t.post('/products', { name: 'Kofe', costPrice: 5 }, mgr.h)).status).toBe(403);
    expect(ok(await t.post('/products', { name: 'Kofe' }, mgr.h), 201).name).toBe('Kofe');
  });
});
