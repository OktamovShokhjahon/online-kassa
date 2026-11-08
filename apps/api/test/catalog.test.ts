import { describe, expect, it } from 'vitest';
import { Price, PriceChange, Product } from '../src/models/catalog';
import { Shop, Terminal } from '../src/models/core';
import { applyScheduledPrices } from '../src/workers/scheduledPrices';
import { P, api, bearer, createShop, login } from './helpers';
import { setup } from './shopCtx';

describe('shop settings (spec 5.1)', () => {
  it('admin edits settings; others cannot; currency locks after first document', async () => {
    const t = await setup();
    const r = await t.patch('/settings', { allowNegativeStock: false, maxCashierDiscount: 12, receiptLanguage: 'ru', currency: 'USD', loyalty: { bonusPercent: 2 } });
    expect(r.status).toBe(200);
    expect(r.body.data.settings).toMatchObject({ allowNegativeStock: false, maxCashierDiscount: 12, receiptLanguage: 'ru' });
    expect(r.body.data.currency).toBe('USD'); // free until the first posted document or sale
    await Shop.updateOne({ _id: t.shop.shopId }, { currencyLocked: true });
    const locked = await t.patch('/settings', { currency: 'RUB' });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('CURRENCY_LOCKED');
    expect((await t.patch('/settings', { currency: 'USD', name: 'Renamed' })).status).toBe(200); // same currency is fine

    const mgr = await t.staff('branch_manager');
    expect((await t.patch('/settings', { name: 'x1' }, mgr.h)).status).toBe(403);
    expect((await t.get('/settings', mgr.h)).status).toBe(200); // everybody in the shop can read
  });

  it('rejects invalid values', async () => {
    const t = await setup();
    expect((await t.patch('/settings', { maxCashierDiscount: 150 })).status).toBe(400);
    expect((await t.patch('/settings', { currency: 'EUR' })).status).toBe(400);
  });

  it('uploads a logo (magic-byte checked, 2 MB max)', async () => {
    const t = await setup();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const r = await api().post(`${P}/settings/logo`).set(t.A).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(r.body.data.logoUrl).toMatch(/^\/uploads\/logos\//);
    const fake = await api().post(`${P}/settings/logo`).set(t.A).attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
    const big = await api().post(`${P}/settings/logo`).set(t.A).attach('file', Buffer.alloc(3 * 1024 * 1024, 1), { filename: 'big.png', contentType: 'image/png' });
    expect(big.status).toBe(400);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('branches and terminals (spec 5.2)', () => {
  it('enforces the branch limit and copies prices into a new branch', async () => {
    const t = await setup();
    const p = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 1_000_000 }] });
    await Shop.updateOne({ _id: t.shop.shopId }, { 'limits.maxBranches': 2 });
    const b2 = await t.post('/branches', { name: 'Second', copyPricesFromBranchId: t.shop.branchId });
    expect(b2.status).toBe(201);
    const price = await Price.findOne({ shopId: t.shop.shopId, branchId: b2.body.data.id, productId: p.id });
    expect(price!.price).toBe(1_000_000);
    const third = await t.post('/branches', { name: 'Third' });
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('LIMIT_REACHED');
  });

  it('branch managers only see their own branches', async () => {
    const t = await setup();
    const b2 = await t.branch('Other');
    const mgr = await t.staff('branch_manager');
    const list = await t.get('/branches', mgr.h);
    expect(list.body.data.map((b: any) => b.id)).toEqual([t.shop.branchId]);
    expect((await t.get(`/branches/${b2}`, mgr.h)).status).toBe(404);
    expect((await t.post('/branches', { name: 'Hack' }, mgr.h)).status).toBe(403);
  });

  it('creates terminals with limits, pairing code (6 digits, 10 min) and agent revoke', async () => {
    const t = await setup();
    await Shop.updateOne({ _id: t.shop.shopId }, { 'limits.maxTerminals': 1 });
    const c = await t.post('/terminals', { name: 'Kassa 1', branchId: t.shop.branchId, printerProfile: { codePage: 'CP866', cutEnabled: true } });
    expect(c.status).toBe(201);
    expect(c.body.data.printerProfile).toMatchObject({ paperWidthMm: 58, charsPerLine: 32, cutEnabled: true });
    expect((await t.post('/terminals', { name: 'Kassa 2', branchId: t.shop.branchId })).status).toBe(422);

    const code = await t.post(`/terminals/${c.body.data.id}/pairing-code`, {});
    expect(code.body.data.code).toMatch(/^\d{6}$/);
    const ttl = new Date(code.body.data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    const stored = await Terminal.findOne({ _id: c.body.data.id, shopId: t.shop.shopId });
    expect(stored!.pairingCodeHash).not.toContain(code.body.data.code); // only a hash is stored

    await Terminal.updateOne({ _id: c.body.data.id, shopId: t.shop.shopId }, { agentTokenHash: 'x', lastSeenAt: new Date() });
    expect((await t.get('/terminals')).body.data[0]).toMatchObject({ paired: true, online: true });
    const rev = await api().delete(`${P}/terminals/${c.body.data.id}/agent`).set(t.A);
    expect(rev.body.data.paired).toBe(false);
    expect(rev.body.data.agentTokenHash).toBeUndefined();
  });
});

describe('staff (spec 5.6, 2.1)', () => {
  it('creates employees; branch manager can create cashiers in own branches only', async () => {
    const t = await setup();
    const b2 = await t.branch('Branch 2');
    const mgr = await t.staff('branch_manager');
    const cashier = await t.post('/users', { role: 'cashier', fullName: 'Cash One', login: 'cash.one', password: 'password123', branchIds: [t.shop.branchId], pin: '1234' }, mgr.h);
    expect(cashier.status).toBe(201);
    expect(cashier.body.data.hasPin).toBe(true);
    expect(JSON.stringify(cashier.body)).not.toMatch(/pinHash|passwordHash/);
    // not in their branch, or not a cashier -> forbidden
    expect((await t.post('/users', { role: 'cashier', fullName: 'Cash Two', login: 'cash.two', password: 'password123', branchIds: [b2] }, mgr.h)).status).toBe(403);
    expect((await t.post('/users', { role: 'storekeeper', fullName: 'Store Kee', login: 'store.kee', password: 'password123', branchIds: [t.shop.branchId] }, mgr.h)).status).toBe(403);
    // the manager list shows only cashiers of their branches
    const list = await t.get('/users', mgr.h);
    expect(list.body.data.map((u: any) => u.login)).toEqual(['cash.one']);
  });

  it('validates permissions grantable per role and unique logins', async () => {
    const t = await setup();
    const bad = await t.post('/users', { role: 'cashier', fullName: 'Cash X', login: 'cashx', password: 'password123', branchIds: [t.shop.branchId], permissions: ['settings.manage'] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('PERMISSION_NOT_GRANTABLE');
    const ok1 = await t.post('/users', { role: 'cashier', fullName: 'Cash X', login: 'cashx', password: 'password123', branchIds: [t.shop.branchId], permissions: ['sales.refund', 'sales.create'] });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.permissions).toContain('sales.refund');
    const dup = await t.post('/users', { role: 'cashier', fullName: 'Cash Y', login: 'CASHX', password: 'password123', branchIds: [t.shop.branchId] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LOGIN_TAKEN');
    expect((await t.post('/users', { role: 'cashier', fullName: 'No Branch', login: 'nobranch', password: 'password123', branchIds: [] })).status).toBe(400);
  });

  it('enforces the employee limit', async () => {
    const t = await setup();
    await Shop.updateOne({ _id: t.shop.shopId }, { 'limits.maxEmployees': 1 });
    await t.staff('cashier');
    const r = await t.post('/users', { role: 'cashier', fullName: 'Second', login: 'second1', password: 'password123', branchIds: [t.shop.branchId] });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LIMIT_REACHED');
  });

  it('deactivation blocks login at once and keeps the record; reset password shows it once', async () => {
    const t = await setup();
    const c = await t.staff('cashier');
    const reset = await t.post(`/users/${c.id}/reset-password`, {});
    expect(reset.body.data.newPassword.length).toBeGreaterThanOrEqual(8);
    await login(c.login, reset.body.data.newPassword);
    await api().patch(`${P}/users/${c.id}/status`).set(t.A).send({ isActive: false }).expect(200);
    expect((await api().get(`${P}/auth/me`).set(c.h)).status).toBeGreaterThanOrEqual(401);
    expect((await api().post(`${P}/auth/login`).send({ login: c.login, password: reset.body.data.newPassword })).status).toBe(403);
    expect((await t.get(`/users/${c.id}`)).body.data.login).toBe(c.login);
  });

  it('nobody can modify the shop admin through the staff API; cashiers cannot manage staff', async () => {
    const t = await setup();
    const c = await t.staff('cashier');
    expect((await t.get('/users', c.h)).status).toBe(403);
    expect((await t.patch(`/users/${t.shop.adminId}`, { fullName: 'Hacked Name' })).status).toBe(403);
  });

  it('permission changes take effect on the next token refresh', async () => {
    const t = await setup();
    const c = await t.staff('cashier');
    await t.patch(`/users/${c.id}`, { permissions: ['sales.refund'] });
    expect((await api().get(`${P}/auth/me`).set(c.h)).status).toBe(401); // old token has a stale permissions version
  });
});

describe('categories (spec 5.3)', () => {
  it('builds a tree up to 3 levels and rejects deeper nesting', async () => {
    const t = await setup();
    const a = (await t.post('/categories', { name: 'A' })).body.data;
    const b = (await t.post('/categories', { name: 'B', parentId: a.id })).body.data;
    const c = (await t.post('/categories', { name: 'C', parentId: b.id })).body.data;
    expect(c.depth).toBe(3);
    const d = await t.post('/categories', { name: 'D', parentId: c.id });
    expect(d.status).toBe(422);
    expect(d.body.error.code).toBe('CATEGORY_DEPTH');
  });

  it('moving a subtree re-checks depth and updates descendants', async () => {
    const t = await setup();
    const a = (await t.post('/categories', { name: 'A' })).body.data;
    const b = (await t.post('/categories', { name: 'B', parentId: a.id })).body.data;
    const c = (await t.post('/categories', { name: 'C', parentId: b.id })).body.data;
    const x = (await t.post('/categories', { name: 'X' })).body.data;
    expect((await t.patch(`/categories/${b.id}`, { parentId: c.id })).status).toBe(422); // into own child
    const moved = await t.patch(`/categories/${a.id}`, { parentId: x.id }); // A(+2 levels) under X -> depth 4
    expect(moved.status).toBe(422);
    const m2 = await t.patch(`/categories/${b.id}`, { parentId: x.id }); // B,C under X -> depths 2,3
    expect(m2.status).toBe(200);
    const list = (await t.get('/categories')).body.data;
    expect(list.find((q: any) => q.id === c.id).depth).toBe(3);
  });

  it('a category with products or children cannot be deleted; products can be moved', async () => {
    const t = await setup();
    const a = (await t.post('/categories', { name: 'A' })).body.data;
    const b = (await t.post('/categories', { name: 'B', parentId: a.id })).body.data;
    const p = await t.product({ categoryId: b.id });
    expect((await api().delete(`${P}/categories/${a.id}`).set(t.A)).body.error.code).toBe('CATEGORY_HAS_CHILDREN');
    expect((await api().delete(`${P}/categories/${b.id}`).set(t.A)).body.error.code).toBe('CATEGORY_HAS_PRODUCTS');
    const mv = await t.post(`/categories/${b.id}/move-products`, { toCategoryId: a.id });
    expect(mv.body.data.moved).toBe(1);
    expect((await api().delete(`${P}/categories/${b.id}`).set(t.A)).status).toBe(200);
    expect((await t.get(`/products/${p.id}`)).body.data.categoryId).toBe(a.id);
  });
});

describe('products (spec 5.4)', () => {
  it('creates products with several barcodes; barcode and SKU are unique per shop', async () => {
    const t = await setup();
    const p1 = await t.post('/products', { name: 'Cola 1L', sku: 'COLA-1', barcodes: ['4006381333931', 'CODE-ABC'], unit: 'piece', vatRate: 12 });
    expect(p1.status).toBe(201);
    const dupBarcode = await t.post('/products', { name: 'Fake', barcodes: ['CODE-ABC'] });
    expect(dupBarcode.status).toBe(409);
    expect(dupBarcode.body.error.code).toBe('DUPLICATE_BARCODE');
    expect(dupBarcode.body.error.details).toMatchObject({ barcode: 'CODE-ABC', productName: 'Cola 1L' });
    const dupSku = await t.post('/products', { name: 'Fake', sku: 'COLA-1' });
    expect(dupSku.body.error.code).toBe('DUPLICATE_SKU');
    // many products without barcode / SKU must not collide
    for (let i = 0; i < 3; i++) expect((await t.post('/products', { name: `No code ${i}` })).status).toBe(201);
    expect((await t.post('/products', { name: 'Empty sku', sku: '' })).status).toBe(201);
    expect((await t.post('/products', { name: 'Empty sku 2', sku: '' })).status).toBe(201);
  });

  it('the same barcode may exist in two different shops', async () => {
    const t1 = await setup();
    const sa = t1.sa;
    const shop2 = await createShop(sa.token);
    const body = { name: 'Same', barcodes: ['4006381333931'] };
    expect((await t1.post('/products', body)).status).toBe(201);
    expect((await api().post(`${P}/products`).set(bearer(shop2.admin.token)).send(body)).status).toBe(201);
  });

  it('searches by name, SKU, barcode; filters category, active, missing MXIK and missing price', async () => {
    const t = await setup();
    const cat = (await t.post('/categories', { name: 'Drinks' })).body.data;
    const sub = (await t.post('/categories', { name: 'Soda', parentId: cat.id })).body.data;
    const cola = await t.product({ name: 'Coca Cola', sku: 'CC1', categoryId: sub.id, mxikCode: '12345678901234567', packageCode: '1234' });
    const water = await t.product({ name: 'Water', categoryId: cat.id });
    await t.product({ name: 'Bread', isActive: false });
    await t.put('/prices', { changes: [{ productId: cola.id, branchId: t.shop.branchId, price: 500_000 }] });

    const names = async (qs: string) => (await t.get(`/products?${qs}`)).body.data.map((p: any) => p.name).sort();
    expect(await names('q=cola')).toEqual(['Coca Cola']);
    expect(await names('q=CC1')).toEqual(['Coca Cola']);
    expect(await names(`q=${cola.barcodes[0].slice(0, 6)}`)).toContain('Coca Cola');
    expect(await names(`categoryId=${cat.id}`)).toEqual(['Coca Cola', 'Water']); // includes subcategory
    expect(await names('active=false')).toEqual(['Bread']);
    expect(await names('missingMxik=true')).toEqual(['Bread', 'Water']);
    expect(await names(`missingPriceBranchId=${t.shop.branchId}`)).toEqual(['Bread', 'Water']);
    const priced = (await t.get(`/products?q=cola&branchId=${t.shop.branchId}`)).body.data[0];
    expect(priced.price).toBe(500_000);
    expect((await t.get(`/products?q=water&branchId=${t.shop.branchId}`)).body.data[0].price).toBeNull();
    expect(water.id).toBeTruthy();
  });

  it('looks up by barcode (with branch price) and 404s on unknown codes', async () => {
    const t = await setup();
    const p = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 123_400 }] });
    const r = await t.get(`/products/by-barcode/${p.barcodes[0]}?branchId=${t.shop.branchId}`);
    expect(r.body.data).toMatchObject({ id: p.id, price: 123_400 });
    const miss = await t.get('/products/by-barcode/0000000000000');
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('validates MXIK format and updates fields', async () => {
    const t = await setup();
    expect((await t.post('/products', { name: 'Bad', mxikCode: '123' })).status).toBe(400);
    const p = await t.product({ mxikCode: '12345678901234567', packageCode: '1500' });
    const u = await t.patch(`/products/${p.id}`, { name: 'Renamed', vatRate: 12, isActive: false });
    expect(u.body.data).toMatchObject({ name: 'Renamed', vatRate: 12, isActive: false, mxikCode: '12345678901234567' });
  });

  it('generates internal EAN-13 barcodes: 2 + shop code + sequence + check digit', async () => {
    const t = await setup();
    const p = await t.product({ barcodes: [] });
    const r1 = await api().post(`${P}/products/${p.id}/generate-barcode`).set(t.A);
    const code = r1.body.data.barcodes[0] as string;
    expect(code).toMatch(/^2\d{12}$/);
    const { isValidEan13 } = await import('@kass/shared');
    expect(isValidEan13(code)).toBe(true);
    const shop = await Shop.findById(t.shop.shopId);
    expect(code.slice(1, 5)).toBe(String(shop!.shopCode).padStart(4, '0'));
    const r2 = await api().post(`${P}/products/${p.id}/generate-barcode`).set(t.A);
    expect(r2.body.data.barcodes).toHaveLength(2);
    expect(r2.body.data.barcodes[1]).not.toBe(code);
  });

  it('only users with products.manage can edit the catalog; cashiers can read it', async () => {
    const t = await setup();
    const cashier = await t.staff('cashier');
    const store = await t.staff('storekeeper');
    expect((await t.post('/products', { name: 'X1' }, cashier.h)).status).toBe(403);
    expect((await t.get('/products', cashier.h)).status).toBe(200);
    expect((await t.post('/products', { name: 'X1' }, store.h)).status).toBe(403);
    // optional permission granted by the admin
    await t.patch(`/users/${store.id}`, { permissions: ['products.manage'] });
    const store2 = await login(store.login, 'password123');
    expect((await t.post('/products', { name: 'X1' }, bearer(store2.token))).status).toBe(201);
  });

  it('uploads a product image', async () => {
    const t = await setup();
    const p = await t.product();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const r = await api().post(`${P}/products/${p.id}/image`).set(t.A).attach('file', png, { filename: 'p.png', contentType: 'image/png' });
    expect(r.body.data.imageUrl).toMatch(/^\/uploads\/products\//);
  });
});

describe('prices (spec 5.5)', () => {
  it('only the shop admin can change prices - not even a manager with every grantable permission', async () => {
    const t = await setup();
    const p = await t.product();
    const { ROLE_GRANTABLE_PERMISSIONS } = await import('@kass/shared');
    const mgr = await t.staff('branch_manager', { permissions: ROLE_GRANTABLE_PERMISSIONS.branch_manager });
    const body = { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 100_000 }] };
    const r = await t.put('/prices', body, mgr.h);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('PRICE_ADMIN_ONLY');
    expect((await t.post('/prices/bulk', { branchIds: [t.shop.branchId], productIds: [p.id], mode: 'percent', value: 10 }, mgr.h)).status).toBe(403);
    expect((await t.post('/prices/copy', { fromBranchId: t.shop.branchId, toBranchIds: [t.shop.branchId] }, mgr.h)).status).toBe(403);
    expect((await t.post('/price-changes', { productId: p.id, branchId: t.shop.branchId, newPrice: 1000, effectiveAt: new Date(Date.now() + 60_000) }, mgr.h)).status).toBe(403);
    // not through product creation either
    expect((await t.post('/products', { name: 'Sneaky', prices: [{ branchId: t.shop.branchId, price: 5 }] }, mgr.h)).status).toBe(403);
    // the cashier can't either
    const cashier = await t.staff('cashier');
    expect((await t.put('/prices', body, cashier.h)).status).toBe(403);
    expect(await Price.countDocuments({ shopId: t.shop.shopId })).toBe(0);
  });

  it('sets per-branch prices through the matrix, records history and skips no-ops', async () => {
    const t = await setup();
    const b2 = await t.branch('Branch 2');
    const p = await t.product();
    const r = await t.put('/prices', { changes: [
      { productId: p.id, branchId: t.shop.branchId, price: 1_000_000 },
      { productId: p.id, branchId: b2, price: 1_200_000 },
    ] });
    expect(r.body.data.changed).toBe(2);
    expect((await t.put('/prices', { changes: [{ productId: p.id, branchId: b2, price: 1_200_000 }] })).body.data.changed).toBe(0);
    await t.put('/prices', { changes: [{ productId: p.id, branchId: b2, price: 1_500_000 }] });

    const matrix = (await t.get('/prices/matrix')).body.data;
    expect(matrix.branches.map((b: any) => b.id).sort()).toEqual([t.shop.branchId, b2].sort());
    expect(matrix.products[0].prices).toEqual({ [t.shop.branchId]: 1_000_000, [b2]: 1_500_000 });

    const hist = (await t.get(`/prices/history?productId=${p.id}&branchId=${b2}`)).body.data;
    expect(hist.map((h: any) => [h.oldPrice, h.newPrice])).toEqual([[1_200_000, 1_500_000], [null, 1_200_000]]);
    expect(hist[0].userId).toBe(t.shop.adminId);
  });

  it('removing a price makes the product unsellable in that branch; rejects bad prices and foreign ids', async () => {
    const t = await setup();
    const p = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 100_000 }] });
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: null }] });
    expect(await Price.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect((await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 0 }] })).status).toBe(400);
    expect((await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 1.5 }] })).status).toBe(400);
    expect((await t.put('/prices', { changes: [{ productId: '64b000000000000000000000', branchId: t.shop.branchId, price: 100 }] })).status).toBe(404);
  });

  it('copies prices between branches (fill-only or overwrite) and applies bulk changes', async () => {
    const t = await setup();
    const b2 = await t.branch('B2');
    const [p1, p2] = [await t.product({ name: 'P1' }), await t.product({ name: 'P2' })];
    await t.put('/prices', { changes: [
      { productId: p1.id, branchId: t.shop.branchId, price: 100_000 },
      { productId: p2.id, branchId: t.shop.branchId, price: 200_000 },
      { productId: p1.id, branchId: b2, price: 111_100 },
    ] });
    const fill = await t.post('/prices/copy', { fromBranchId: t.shop.branchId, toBranchIds: [b2] });
    expect(fill.body.data.changed).toBe(1); // only P2 was missing
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p1.id, branchId: b2 }))!.price).toBe(111_100);
    await t.post('/prices/copy', { fromBranchId: t.shop.branchId, toBranchIds: [b2], overwrite: true });
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p1.id, branchId: b2 }))!.price).toBe(100_000);

    const pct = await t.post('/prices/bulk', { branchIds: [b2], productIds: [p1.id, p2.id], mode: 'percent', value: 10 });
    expect(pct.body.data.changed).toBe(2);
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p2.id, branchId: b2 }))!.price).toBe(220_000);
    const fixed = await t.post('/prices/bulk', { branchIds: [t.shop.branchId], productIds: [p1.id], mode: 'fixed', value: -25_000 });
    expect(fixed.body.data.changed).toBe(1);
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p1.id, branchId: t.shop.branchId }))!.price).toBe(75_000);
    // never produces a non-positive price
    const kill = await t.post('/prices/bulk', { branchIds: [t.shop.branchId], productIds: [p1.id], mode: 'fixed', value: -1_000_000 });
    expect(kill.body.data.changed).toBe(0);
    expect(kill.body.data.skippedNonPositive).toBe(1);
  });

  it('bulk change by category covers subcategories', async () => {
    const t = await setup();
    const cat = (await t.post('/categories', { name: 'Top' })).body.data;
    const sub = (await t.post('/categories', { name: 'Sub', parentId: cat.id })).body.data;
    const p = await t.product({ categoryId: sub.id });
    const other = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 100_000 }, { productId: other.id, branchId: t.shop.branchId, price: 100_000 }] });
    await t.post('/prices/bulk', { branchIds: [t.shop.branchId], categoryId: cat.id, mode: 'percent', value: 50 });
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p.id }))!.price).toBe(150_000);
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: other.id }))!.price).toBe(100_000);
  });

  it('schedules a price change that the worker applies at the right time, once', async () => {
    const t = await setup();
    const p = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 100_000 }] });
    expect((await t.post('/price-changes', { productId: p.id, branchId: t.shop.branchId, newPrice: 90_000, effectiveAt: new Date(Date.now() - 1000) })).body.error.code).toBe('SCHEDULE_IN_PAST');
    const eff = new Date(Date.now() + 3600_000);
    const sc = await t.post('/price-changes', { productId: p.id, branchId: t.shop.branchId, newPrice: 90_000, effectiveAt: eff });
    expect(sc.status).toBe(201);
    expect((await t.get('/price-changes')).body.data).toHaveLength(1);
    expect(await applyScheduledPrices(new Date())).toBe(0); // not yet
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p.id }))!.price).toBe(100_000);
    expect(await applyScheduledPrices(new Date(eff.getTime() + 1000))).toBe(1);
    expect(await applyScheduledPrices(new Date(eff.getTime() + 2000))).toBe(0);
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: p.id }))!.price).toBe(90_000);
    const done = await PriceChange.findOne({ _id: sc.body.data.id, shopId: t.shop.shopId });
    expect(done).toMatchObject({ status: 'applied', oldPrice: 100_000, newPrice: 90_000 });
  });

  it('a scheduled change can be cancelled', async () => {
    const t = await setup();
    const p = await t.product();
    const sc = await t.post('/price-changes', { productId: p.id, branchId: t.shop.branchId, newPrice: 90_000, effectiveAt: new Date(Date.now() + 3600_000) });
    expect((await api().delete(`${P}/price-changes/${sc.body.data.id}`).set(t.A)).status).toBe(200);
    expect(await applyScheduledPrices(new Date(Date.now() + 7200_000))).toBe(0);
    expect((await api().delete(`${P}/price-changes/${sc.body.data.id}`).set(t.A)).status).toBe(404);
  });

  it('a new price is created for the correct shop only', async () => {
    const t = await setup();
    const p = await t.product();
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 100 }] });
    const pr = await Price.findOne({ productId: p.id }).setOptions({ crossTenant: true });
    expect(String(pr!.shopId)).toBe(t.shop.shopId);
  });
});

describe('import / export (spec 5.4)', () => {
  const csv = (rows: string[]) => Buffer.from(rows.join('\n'), 'utf8');
  const importOptions = (extra: object) => JSON.stringify({ mapping: { name: 'Nomi', barcode: 'Shtrix', price: 'Narx', category: 'Kategoriya', sku: 'SKU', unit: 'Birlik' }, ...extra });

  it('previews a file with auto-detected column mapping', async () => {
    const t = await setup();
    const file = csv(['Nomi;Shtrix;Narx', 'Cola;4006381333931;12 000', 'Fanta;4006381333948;11 000']);
    const r = await api().post(`${P}/products/import/preview`).set(t.A).attach('file', file, 'items.csv');
    expect(r.status).toBe(200);
    expect(r.body.data.columns).toEqual(['Nomi', 'Shtrix', 'Narx']);
    expect(r.body.data.totalRows).toBe(2);
    expect(r.body.data.suggestedMapping).toMatchObject({ name: 'Nomi', barcode: 'Shtrix', price: 'Narx' });
  });

  it('imports products and prices for chosen branches, creating categories; reports errors per row', async () => {
    const t = await setup();
    const b2 = await t.branch('B2');
    const file = csv([
      'Nomi,Shtrix,Narx,Kategoriya,SKU,Birlik',
      'Cola,4006381333931,12000,Drinks > Soda,C1,dona',
      'Fanta,4006381333948,"11 000,50",Drinks > Soda,C2,dona',
      ',111,5,,,',
      'Rice,2222222222222,abc,Food,,kg',
      'Cola dup,4006381333931,1,,,',
      'Flour,3333333333333,9000,Food,,xx',
    ]);
    const r = await api().post(`${P}/products/import`).set(t.A)
      .field('options', importOptions({ updateExisting: false, priceBranchIds: [t.shop.branchId, b2] }))
      .attach('file', file, 'items.csv');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ total: 6, created: 2, updated: 0, skipped: 1, pricesSet: 4 });
    expect(d.errors.map((e: any) => e.row)).toEqual([4, 5, 7]); // blank name, bad price, unknown unit
    expect(await Product.countDocuments({ shopId: t.shop.shopId })).toBe(2);
    const cats = (await t.get('/categories')).body.data;
    expect(cats.map((c: any) => `${c.depth}:${c.name}`).sort()).toEqual(['1:Drinks', '2:Soda']);
    const fanta = await Product.findOne({ shopId: t.shop.shopId, sku: 'C2' });
    expect((await Price.findOne({ shopId: t.shop.shopId, productId: fanta!._id, branchId: b2 }))!.price).toBe(1_100_050);
  });

  it('updates existing products by barcode or SKU and adds barcodes', async () => {
    const t = await setup();
    await t.product({ name: 'Old name', barcodes: ['4006381333931'], sku: 'S1' });
    const file = csv(['Nomi,Shtrix,SKU', 'New name,4006381333931;9999999999999,S1']);
    const r = await api().post(`${P}/products/import`).set(t.A).field('options', importOptions({ updateExisting: true, priceBranchIds: [] })).attach('file', file, 'x.csv');
    expect(r.body.data).toMatchObject({ created: 0, updated: 1 });
    const p = await Product.findOne({ shopId: t.shop.shopId });
    expect(p!.name).toBe('New name');
    expect(p!.barcodes.sort()).toEqual(['4006381333931', '9999999999999']);
  });

  it('only the shop admin can import prices; rejects non-spreadsheet files', async () => {
    const t = await setup();
    const store = await t.staff('storekeeper', { permissions: ['products.manage'] });
    const file = csv(['Nomi,Narx', 'Tea,5000']);
    const withPrices = await api().post(`${P}/products/import`).set(store.h).field('options', importOptions({ priceBranchIds: [t.shop.branchId] })).attach('file', file, 'x.csv');
    expect(withPrices.status).toBe(403);
    const noPrices = await api().post(`${P}/products/import`).set(store.h).field('options', importOptions({ priceBranchIds: [] })).attach('file', file, 'x.csv');
    expect(noPrices.status).toBe(200);
    const bad = await api().post(`${P}/products/import/preview`).set(t.A).attach('file', Buffer.from('MZ binary'), 'virus.exe');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  it('exports the catalog with per-branch price columns as .xlsx', async () => {
    const t = await setup();
    const p = await t.product({ name: 'Exported' });
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 1_250_000 }] });
    const r = await api().get(`${P}/products/export`).set(t.A).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.headers['content-type']).toContain('spreadsheetml');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    const ws = wb.worksheets[0];
    expect(String(ws.getRow(1).getCell(12).value)).toContain('Price:');
    expect(ws.getRow(2).getCell(1).value).toBe('Exported');
    expect(ws.getRow(2).getCell(12).value).toBe(12500);
  });

  it('renders a price label PDF', async () => {
    const t = await setup();
    const p = await t.product({ name: 'Колбаса Докторская', barcodes: ['4006381333931'] });
    await t.put('/prices', { changes: [{ productId: p.id, branchId: t.shop.branchId, price: 4_500_000 }] });
    const r = await api().post(`${P}/products/labels`).set(t.A).send({ branchId: t.shop.branchId, items: [{ productId: p.id, copies: 5 }] })
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('tenant isolation of the shop workspace (spec 15.2)', () => {
  it('shop B cannot read, change or detect shop A data through any endpoint', async () => {
    const a = await setup();
    const shopB = await createShop(a.sa.token);
    const B = bearer(shopB.admin.token);

    const cat = (await a.post('/categories', { name: 'A cat' })).body.data;
    const prod = await a.product({ name: 'Secret product', categoryId: cat.id });
    await a.put('/prices', { changes: [{ productId: prod.id, branchId: a.shop.branchId, price: 777_700 }] });
    const staff = await a.staff('cashier');
    const term = (await a.post('/terminals', { name: 'A term', branchId: a.shop.branchId })).body.data;
    const bGet = (path: string) => api().get(`${P}${path}`).set(B);
    const bSend = (m: 'patch' | 'post' | 'put' | 'delete', path: string, body: object = {}) => (api() as any)[m](`${P}${path}`).set(B).send(body);

    // reads by id -> 404 (indistinguishable from "does not exist")
    for (const path of [`/products/${prod.id}`, `/users/${staff.id}`, `/branches/${a.shop.branchId}`]) {
      expect((await bGet(path)).status, path).toBe(404);
    }
    expect((await bGet(`/products/by-barcode/${prod.barcodes[0]}`)).status).toBe(404);
    // lists never include A's data
    expect((await bGet('/products')).body.data).toHaveLength(0);
    expect((await bGet('/categories')).body.data).toHaveLength(0);
    expect((await bGet('/users')).body.data.map((u: any) => u.login)).not.toContain(staff.login);
    expect((await bGet('/branches')).body.data.map((b: any) => b.id)).toEqual([shopB.branchId]);
    expect((await bGet('/terminals')).body.data).toHaveLength(0);
    expect(JSON.stringify((await bGet('/prices/matrix')).body)).not.toContain('Secret product');
    expect((await bGet(`/products?q=secret`)).body.data).toHaveLength(0);

    // writes aimed at A's ids fail and change nothing
    expect((await bSend('patch', `/products/${prod.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await bSend('patch', `/users/${staff.id}`, { fullName: 'Hacked Name' })).status).toBe(404);
    expect((await bSend('patch', `/branches/${a.shop.branchId}`, { name: 'hacked' })).status).toBe(404);
    expect((await bSend('patch', `/terminals/${term.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await bSend('post', `/terminals/${term.id}/pairing-code`)).status).toBe(404);
    expect((await bSend('patch', `/categories/${cat.id}`, { name: 'hacked' })).status).toBe(404);
    expect((await bSend('post', `/users/${staff.id}/reset-password`)).status).toBe(404);
    // B cannot price A's product or use A's branch
    expect((await bSend('put', '/prices', { changes: [{ productId: prod.id, branchId: shopB.branchId, price: 1 + 99 }] })).status).toBe(404);
    expect((await bSend('put', '/prices', { changes: [{ productId: (await Product.findOne({ shopId: shopB.shopId }) ?? { _id: '64b000000000000000000000' })._id, branchId: a.shop.branchId, price: 100 }] })).status).toBe(404);
    // B cannot attach its product to A's category / users to A's branch
    expect((await bSend('post', '/products', { name: 'Mine', categoryId: cat.id })).status).toBe(404);
    expect((await bSend('post', '/users', { role: 'cashier', fullName: 'Intruder', login: 'intruder1', password: 'password123', branchIds: [a.shop.branchId] })).status).toBe(404);

    // A's data is intact
    const after = await Product.findOne({ shopId: a.shop.shopId });
    expect(after!.name).toBe('Secret product');
    expect((await Price.findOne({ shopId: a.shop.shopId }))!.price).toBe(777_700);
    expect((await Price.countDocuments({ shopId: shopB.shopId }))).toBe(0);
  });

  it('a shopId smuggled into a request body is ignored', async () => {
    const a = await setup();
    const shopB = await createShop(a.sa.token);
    const r = await a.post('/products', { name: 'Smuggle', shopId: shopB.shopId });
    expect(r.status).toBe(201);
    expect(await Product.countDocuments({ shopId: shopB.shopId })).toBe(0);
    expect(await Product.countDocuments({ shopId: a.shop.shopId })).toBe(1);
  });
});
