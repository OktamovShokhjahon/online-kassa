/**
 * Happy paths of the routes no other test file calls successfully (found by walking every
 * Express route and recording which ones the suite reached with a 2xx).
 */
import { describe, expect, it } from 'vitest';
import { TelegramRecipient } from '../src/models/integrations';
import { P, api, bearer } from './helpers';
import { posCtx } from './posCtx';

const ok = (r: { status: number; body: any }, status = 200) => {
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

describe('company settings: branches, terminals, suppliers', () => {
  it('reads and updates a branch, a terminal and a supplier', async () => {
    const t = await posCtx({ openShift: false });
    const b = ok(await t.get(`/branches/${t.shop.branchId}`));
    expect(b.id).toBe(t.shop.branchId);
    expect(ok(await t.patch(`/branches/${t.shop.branchId}`, { phone: '+998 71 200 00 00', receiptFooter: 'Come again' })).receiptFooter).toBe('Come again');

    const term = ok(await t.patch(`/terminals/${t.term.id}`, { name: 'Kassa A', printerProfile: { paperWidthMm: 80, charsPerLine: 48, printWidthDots: 576 } }));
    expect(term).toMatchObject({ name: 'Kassa A', printerProfile: { paperWidthMm: 80 } });

    expect(ok(await t.patch(`/suppliers/${t.supplierId}`, { phone: '+998 90 111 22 33' })).phone).toBe('+998901112233');
  });
});

describe('product codes', () => {
  it('reserves a fresh internal EAN-13 for a new product form; storekeepers without products.manage cannot', async () => {
    const t = await posCtx({ openShift: false });
    const a = ok(await t.post('/products/reserve-barcode', {})).code;
    const b = ok(await t.post('/products/reserve-barcode', {})).code;
    expect(a).toMatch(/^2\d{12}$/);
    expect(b).not.toBe(a);
    const p = ok(await t.post('/products', { name: 'Auto coded', barcodes: [a] }), 201);
    expect(ok(await t.get(`/products/by-barcode/${a}`)).id).toBe(p.id);
    expect((await t.post('/products/reserve-barcode', {}, t.cashier.h)).status).toBe(403);
  });
});

describe('product code sheets', () => {
  it('exports every product as a QR / barcode PDF and gives barcode-less products a code first', async () => {
    const t = await posCtx({ openShift: false });
    const bare = ok(await t.post('/products', { name: 'No code yet' }), 201);
    expect(bare.barcodes).toEqual([]);
    const pdf = (r: any) => (r.body instanceof Buffer ? r.body : Buffer.from(r.text ?? '', 'binary'));
    const get = (type: string, h = t.A) => api().get(`${P}/products/codes?type=${type}`).set(h).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

    const qr = await get('qr');
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('application/pdf');
    expect(pdf(qr).subarray(0, 5).toString()).toBe('%PDF-');
    expect(qr.headers['x-codes-generated']).toBe('1');
    expect(Number(qr.headers['x-codes-count'])).toBe(3); // cola, bread, the new one
    const after = ok(await t.get(`/products/${bare.id}`));
    expect(after.barcodes[0]).toMatch(/^2\d{12}$/);

    // the JSON list behind the ZIP download: one entry per product, the same codes as the PDF
    const list = ok(await t.get('/products/codes?type=qr&format=json'));
    expect(list.generated).toBe(0);
    expect(list.items.map((i: any) => i.code)).toContain(after.barcodes[0]);
    expect(list.items).toHaveLength(3);

    const bars = await get('barcode');
    expect(bars.status).toBe(200);
    expect(bars.headers['x-codes-generated']).toBe('0');
    expect(pdf(bars).length).toBeGreaterThan(1000);
    // a cashier may export (they can view products) but never creates barcodes: the product without one is skipped
    ok(await t.post('/products', { name: 'Still no code' }), 201);
    const asCashier = await get('qr', t.cashier.h);
    expect(asCashier.status).toBe(200);
    expect(asCashier.headers['x-codes-generated']).toBe('0');
    expect(Number(asCashier.headers['x-codes-count'])).toBe(3);
  });
});

describe('stock documents', () => {
  it('edits a draft goods receipt, then reads it', async () => {
    const t = await posCtx({ openShift: false });
    const draft = ok(await t.post('/goods-receipts', { supplierId: t.supplierId, branchId: t.shop.branchId, lines: [{ productId: t.cola.id, qty: 5, cost: 700_000 }] }), 201);
    const edited = ok(await t.patch(`/goods-receipts/${draft.id}`, { invoiceNo: 'INV-77', lines: [{ productId: t.cola.id, qty: 7, cost: 690_000 }] }));
    expect(edited.invoiceNo).toBe('INV-77');
    const read = ok(await t.get(`/goods-receipts/${draft.id}`));
    expect(read.lines[0]).toMatchObject({ qty: 7, cost: 690_000 });
  });

  it('posts a supplier return and a write-off; lists and reads them', async () => {
    const t = await posCtx({ openShift: false });
    const before = (await t.stockOf(t.cola.id)).quantity;
    const ret = ok(await t.post('/supplier-returns', { supplierId: t.supplierId, branchId: t.shop.branchId, reason: 'Damaged packs', lines: [{ productId: t.cola.id, qty: 2, cost: 700_000 }] }), 201);
    ok(await t.post(`/supplier-returns/${ret.id}/post`, {}));
    expect(ok(await t.get(`/supplier-returns/${ret.id}`)).status).toBe('posted');
    expect(ok(await t.get('/supplier-returns')).length).toBe(1);

    const wo = ok(await t.post('/write-offs', { branchId: t.shop.branchId, reason: 'damaged', lines: [{ productId: t.cola.id, qty: 1 }] }), 201);
    ok(await t.post(`/write-offs/${wo.id}/post`, {}));
    expect(ok(await t.get(`/write-offs/${wo.id}`)).status).toBe('posted');
    expect(ok(await t.get('/write-offs')).length).toBe(1);
    expect((await t.stockOf(t.cola.id)).quantity).toBe(before - 3);
  });

  it('cancels a stock count and lists counts', async () => {
    const t = await posCtx({ openShift: false });
    const c = ok(await t.post('/stock-counts', { branchId: t.shop.branchId }), 201);
    ok(await t.post(`/stock-counts/${c.id}/cancel`, { reason: 'Recount next week' }));
    const list = ok(await t.get('/stock-counts'));
    expect(list.find((x: any) => x.id === c.id).status).toBe('cancelled');
  });

  it('lists supplier payments', async () => {
    const t = await posCtx({ openShift: false });
    ok(await t.post('/supplier-payments', { supplierId: t.supplierId, amount: 100_000, method: 'cash' }), 201);
    expect(ok(await t.get('/supplier-payments')).length).toBe(1);
  });
});

describe('cash desk reads', () => {
  it('PIN login at a terminal, shift and cash operations, sale and refund details', async () => {
    const t = await posCtx();
    const pin = ok(await t.post('/auth/pin-login', { terminalId: t.term.id, login: t.cashier.login, pin: '1234' }, t.cashier.h));
    expect(pin.accessToken).toBeTruthy();
    expect((await t.post('/auth/pin-login', { terminalId: t.term.id, login: t.cashier.login, pin: '0000' }, t.cashier.h)).status).toBe(401);

    expect(ok(await t.get('/pos/cashiers?terminalId=' + t.term.id, t.cashier.h)).length).toBeGreaterThan(0);
    ok(await t.post('/cash-operations', { shiftId: t.shiftId, type: 'in', amount: 10_000, comment: 'float' }, t.cashier.h), 201);
    expect(ok(await t.get(`/cash-operations?shiftId=${t.shiftId}`, t.cashier.h)).length).toBe(1);
    expect(ok(await t.get(`/shifts/${t.shiftId}`, t.cashier.h)).id).toBe(t.shiftId);

    const sale = ok(await t.sell([{ productId: t.cola.id, qty: 2 }], [{ method: 'cash', amount: 2_400_000 }]), 201);
    expect(ok(await t.get(`/sales/${sale.id}`)).number).toBe(sale.number);
    const refund = ok(await t.post('/refunds', { saleId: sale.id, shiftId: t.shiftId, lines: [{ productId: t.cola.id, qty: 1 }], method: 'cash', reason: 'Changed mind', approval: { login: t.manager.login, pin: '9999' } }, t.cashier.h), 201);
    expect(ok(await t.get(`/refunds/${refund.id}`)).id).toBe(refund.id);
    expect(ok(await t.get('/refunds')).length).toBe(1);
    expect(ok(await t.get('/prices?branchId=' + t.shop.branchId)).length).toBeGreaterThan(0);
  });

  it('customers, customer payments and promotions by id', async () => {
    const t = await posCtx();
    const c = ok(await t.post('/customers', { fullName: 'Aziz Karimov', phone: '+998901112233', creditLimit: 1_000_000 }), 201);
    expect(ok(await t.get(`/customers/${c.id}`)).fullName).toBe('Aziz Karimov');
    expect(ok(await t.get('/customer-payments'))).toEqual([]);
    const promo = ok(await t.post('/promotions', { name: 'Ten off', type: 'percent', rules: { percent: 10, productIds: [t.cola.id] } }), 201);
    expect(ok(await t.get(`/promotions/${promo.id}`)).name).toBe('Ten off');
  });
});

describe('integrations and platform', () => {
  it('deletes a webhook; superadmin reads settings, fiscal providers and Telegram recipients', async () => {
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
    const t = await posCtx({ openShift: false });
    const w = ok(await t.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['sale.created'] }), 201);
    ok(await api().delete(`${P}/webhooks/${w.id}`).set(t.A));
    expect((await api().delete(`${P}/webhooks/${w.id}`).set(t.A)).status).toBe(404);

    const SA = bearer(t.sa.token);
    expect(ok(await api().get(`${P}/admin/settings`).set(SA))).toHaveProperty('graceDays');
    expect(ok(await t.get('/fiscal/providers'))).toContain('mock');
    const rec = await TelegramRecipient.create({ shopId: null, userId: t.cashier.id, chatId: '42' });
    expect(ok(await api().get(`${P}/admin/telegram/recipients`).set(SA)).length).toBe(1);
    ok(await api().delete(`${P}/admin/telegram/recipients/${rec.id}`).set(SA));
    expect((await api().delete(`${P}/admin/telegram/recipients/${rec.id}`).set(SA)).status).toBe(404);
    expect(ok(await api().get(`${P}/health`))).toMatchObject({ status: 'ok' });
  });
});
