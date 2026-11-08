import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { events } from '../src/lib/events';
import { setTelegramTransport } from '../src/lib/telegram';
import { ApiKey, Webhook, WebhookDelivery, TelegramRecipient } from '../src/models/integrations';
import { AuditLog, Shop } from '../src/models/core';
import { Sale } from '../src/models/sales';
import { Stock } from '../src/models/stock';
import { deliverDue } from '../src/modules/developers/webhooks';
import { dailySummaryJob, debtReminderJob, expiryNoticeJob, longShiftJob } from '../src/modules/telegram/notifier';
import { resetSubscribers, startSubscribers } from '../src/subscribers';
import { expireShops } from '../src/workers/shopExpiry';
import { P, api, bearer } from './helpers';
import { COLA, posCtx } from './posCtx';

type Ctx = Awaited<ReturnType<typeof posCtx>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => any, ms = 3000): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

const sent: Array<{ chatId: string; text: string }> = [];
beforeEach(() => {
  process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
  sent.length = 0;
  setTelegramTransport(async (chatId, text) => void sent.push({ chatId, text }));
  events.clear();
  resetSubscribers();
  startSubscribers();
});

async function createKey(t: Ctx, scopes: string[], extra: Record<string, unknown> = {}) {
  const r = await t.post('/api-keys', { name: 'Integration', scopes, ...extra });
  expect(r.status).toBe(201);
  return { key: r.body.data.key as string, id: r.body.data.id as string, h: bearer(r.body.data.key) };
}
const pub = (path: string, h: any) => api().get(`${P}/public${path}`).set(h);

/* ============================================================================ API keys */

describe('API keys (spec 10.2)', () => {
  it('shows the full key once; lists only a prefix and the last 4 characters; stores a hash', async () => {
    const t = await posCtx();
    const created = await t.post('/api-keys', { name: 'ERP', scopes: ['products:read', 'stock:read'] });
    expect(created.body.data.key).toMatch(/^kk_live_[\w-]{40,}$/);
    const list = (await t.get('/api-keys')).body.data;
    expect(list[0]).toMatchObject({ name: 'ERP', active: true, requestCount: 0 });
    expect(list[0].display).toBe(`${created.body.data.key.slice(0, 12)}…${created.body.data.key.slice(-4)}`);
    expect(JSON.stringify(list)).not.toContain(created.body.data.key);
    const stored = (await ApiKey.findOne({ shopId: t.shop.shopId }).lean())!;
    expect(stored.keyHash).toBe(crypto.createHash('sha256').update(created.body.data.key).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(created.body.data.key);
  });

  it('only the shop admin manages keys; scopes are validated', async () => {
    const t = await posCtx();
    expect((await t.post('/api-keys', { name: 'x1', scopes: ['products:read'] }, t.manager.h)).status).toBe(403);
    expect((await t.get('/api-keys', t.cashier.h)).status).toBe(403);
    expect((await t.post('/api-keys', { name: 'Key', scopes: [] })).status).toBe(400);
    expect((await t.post('/api-keys', { name: 'Key', scopes: ['prices:write'] })).status).toBe(400); // there is no price write scope
    expect((await t.post('/api-keys', { name: 'Key', scopes: ['products:read'], branchId: '64b000000000000000000000' })).status).toBe(404);
  });

  it('authenticates, enforces scopes and reports rate-limit headers and usage', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:read']);
    expect((await api().get(`${P}/public/products`)).body.error.code).toBe('API_KEY_INVALID');
    expect((await pub('/products', bearer('kk_live_nope'))).status).toBe(401);
    const ok = await pub('/products', k.h);
    expect(ok.status).toBe(200);
    expect(ok.headers['x-ratelimit-limit']).toBe('120');
    expect(Number(ok.headers['x-ratelimit-remaining'])).toBe(119);
    const denied = await pub('/prices?branchId=' + t.shop.branchId, k.h);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SCOPE_MISSING');
    await waitFor(async () => (await ApiKey.findOne({ _id: k.id, shopId: t.shop.shopId }))!.requestCount >= 2);
    expect((await ApiKey.findOne({ _id: k.id, shopId: t.shop.shopId }))!.lastUsedAt).toBeTruthy();
    // a user token is not an API key and vice versa
    expect((await pub('/products', t.A)).status).toBe(401);
    expect((await api().get(`${P}/products`).set(k.h)).status).toBe(401);
  });

  it('rate limits at 120 requests per minute per key', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:read']);
    const other = await createKey(t, ['products:read']);
    for (let i = 0; i < 120; i++) expect((await pub('/products?limit=1', k.h)).status).toBe(200);
    const blocked = await pub('/products', k.h);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect((await pub('/products', other.h)).status).toBe(200); // limits are per key
  }, 60_000);

  it('revoked and expired keys stop working at once', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:read']);
    const exp = await createKey(t, ['products:read'], { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await pub('/products', k.h)).status).toBe(200);
    await api().delete(`${P}/api-keys/${k.id}`).set(t.A).expect(200);
    expect((await pub('/products', k.h)).status).toBe(401);
    await ApiKey.updateOne({ _id: exp.id, shopId: t.shop.shopId }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await pub('/products', exp.h)).status).toBe(401);
    expect((await t.get('/api-keys')).body.data.map((x: any) => x.active)).toEqual([false, false]);
  });

  it('a blocked shop loses API access immediately; data is intact after unblocking', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:read']);
    await api().post(`${P}/admin/shops/${t.shop.shopId}/block`).set(bearer(t.sa.token)).send({ reason: 'unpaid' }).expect(200);
    const r = await pub('/products', k.h);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SHOP_BLOCKED');
    await api().post(`${P}/admin/shops/${t.shop.shopId}/unblock`).set(bearer(t.sa.token)).expect(200);
    expect((await pub('/products', k.h)).status).toBe(200);
  });

  it('a key bound to a branch sees only that branch', async () => {
    const t = await posCtx();
    const b2 = await t.branch('Second');
    const k = await createKey(t, ['stock:read', 'sales:read', 'reports:read'], { branchId: t.shop.branchId });
    expect((await pub(`/stock?branchId=${b2}`, k.h)).status).toBe(403);
    expect((await pub(`/stock?branchId=${t.shop.branchId}`, k.h)).status).toBe(200);
    expect((await pub(`/reports/daily?branchId=${b2}`, k.h)).status).toBe(403);
  });

  it("one shop's key cannot read another shop's data", async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    const kb = await createKey(b, ['products:read', 'stock:read', 'customers:read']);
    expect((await pub('/products', kb.h)).body.data.map((p: any) => p.id)).not.toContain(a.cola.id);
    expect((await pub(`/stock?branchId=${a.shop.branchId}`, kb.h)).status).toBe(404);
    expect((await pub(`/products/by-barcode/${a.cola.barcodes[0]}`, kb.h)).status).toBe(404);
  });
});

/* ======================================================================== public API */

describe('public REST API (spec 10.3)', () => {
  it('lists, searches and looks up products; the price appears only for keys that may read prices', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:read', 'prices:read']);
    const onlyProducts = await createKey(t, ['products:read']);
    const list = await pub('/products?q=cola', k.h);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta).toMatchObject({ total: 1, page: 1 });
    expect(list.body.data[0]).toMatchObject({ name: 'Cola 1L', mxikCode: '12345678901234567', barcodes: [t.cola.barcodes[0]] });
    const withPrice = await pub(`/products/by-barcode/${t.cola.barcodes[0]}?branchId=${t.shop.branchId}`, k.h);
    expect(withPrice.body.data.price).toBe(COLA.price);
    expect((await pub(`/products/by-barcode/${t.cola.barcodes[0]}?branchId=${t.shop.branchId}`, onlyProducts.h)).body.data.price).toBeUndefined();
    expect((await pub('/products/by-barcode/0000', k.h)).status).toBe(404);
    expect((await pub('/products?updatedSince=2999-01-01T00:00:00Z', k.h)).body.data).toHaveLength(0);
  });

  it('creates and updates products but can never set prices', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['products:write', 'products:read']);
    const post = (b: object) => api().post(`${P}/public/products`).set(k.h).send(b);
    const c = await post({ name: 'API product', barcodes: ['9990001112223'] });
    expect(c.status).toBe(201);
    expect(c.body.data.barcodes).toEqual(['9990001112223']);
    expect((await post({ name: 'Dup', barcodes: ['9990001112223'] })).body.error.code).toBe('DUPLICATE_BARCODE');
    const priced = await post({ name: 'Priced', prices: [{ branchId: t.shop.branchId, price: 100 }] });
    expect(priced.status).toBe(403);
    expect(priced.body.error.code).toBe('PRICE_ADMIN_ONLY');

    const patch = (b: object) => api().patch(`${P}/public/products/${c.body.data.id}`).set(k.h).send(b);
    expect((await patch({ name: 'Renamed', barcodes: ['9990001112223', '9990001112224'] })).body.data).toMatchObject({ name: 'Renamed', barcodes: ['9990001112223', '9990001112224'] });
    expect((await patch({ vatRate: 99 })).status).toBe(400); // only name, barcodes, category
    expect((await patch({ price: 5 })).status).toBe(400);
    expect((await patch({ barcodes: [t.cola.barcodes[0]] })).body.error.code).toBe('DUPLICATE_BARCODE');
    const readOnly = await createKey(t, ['products:read']);
    expect((await api().post(`${P}/public/products`).set(readOnly.h).send({ name: 'No' })).status).toBe(403);
  });

  it('exposes prices and stock of a branch', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['prices:read', 'stock:read']);
    const prices = (await pub(`/prices?branchId=${t.shop.branchId}`, k.h)).body;
    expect(prices.meta.total).toBe(2);
    expect(prices.data.find((p: any) => p.productId === t.cola.id).price).toBe(COLA.price);
    const stock = (await pub(`/stock?branchId=${t.shop.branchId}&limit=1000`, k.h)).body.data;
    expect(stock.find((s: any) => s.productId === t.cola.id).quantity).toBe(100);
    expect((await pub('/stock', k.h)).status).toBe(400); // branchId required
  });

  it('registers a sale from an external system, idempotently, on the integration terminal', async () => {
    const t = await posCtx();
    const k = await createKey(t, ['sales:write', 'sales:read']);
    const body = { clientRequestId: crypto.randomUUID(), terminalId: t.term.id, shiftId: t.shiftId, lines: [{ productId: t.cola.id, qty: 2 }], payments: [{ method: 'card', amount: 2 * COLA.price }] };
    const post = (b: object) => api().post(`${P}/public/sales`).set(k.h).send(b);
    const r1 = await post(body);
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ total: 2 * COLA.price, number: '1-000001', status: 'completed' });
    const r2 = await post(body);
    expect(r2.status).toBe(200);
    expect(r2.body.data).toMatchObject({ id: r1.body.data.id, duplicate: true });
    expect((await Stock.findOne({ shopId: t.shop.shopId, productId: t.cola.id }))!.quantity).toBe(98);

    // minimal rights: no manual discount override, no credit, no approvals
    expect((await post({ ...body, clientRequestId: crypto.randomUUID(), approval: { login: 'x', pin: '1234' } })).status).toBe(400);
    const credit = await post({ ...body, clientRequestId: crypto.randomUUID(), customerId: '64b000000000000000000000', payments: [{ method: 'credit', amount: 2 * COLA.price }] });
    expect([403, 404]).toContain(credit.status);
    expect((await post({ ...body, clientRequestId: crypto.randomUUID(), shiftId: '64b000000000000000000000' })).status).toBe(404);

    const list = await pub('/sales', k.h);
    expect(list.body.data).toHaveLength(1);
    expect((await pub(`/sales/${r1.body.data.id}`, k.h)).body.data.lines[0]).toMatchObject({ name: 'Cola 1L', qty: 2 });
    expect((await pub(`/sales?number=1-000001`, k.h)).body.data).toHaveLength(1);
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(1);
  });

  it('serves customers with balances and the daily report', async () => {
    const t = await posCtx();
    await t.post('/customers', { fullName: 'Public Customer', phone: '+998 90 111 00 11' }, t.cashier.h);
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    const k = await createKey(t, ['customers:read', 'reports:read']);
    const c = (await pub('/customers?q=public', k.h)).body.data;
    expect(c).toEqual([expect.objectContaining({ fullName: 'Public Customer', bonusBalance: 0, debtBalance: 0 })]);
    const d = (await pub('/reports/daily', k.h)).body.data;
    expect(d).toEqual([expect.objectContaining({ receipts: 1, revenue: COLA.price, netRevenue: COLA.price, branchName: expect.any(String) })]);
  });
});

describe('OpenAPI documentation (spec 10.1)', () => {
  it('publishes an OpenAPI 3 document covering every public endpoint', async () => {
    const r = await api().get(`${P}/docs/openapi.json`);
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\./);
    const ops = Object.entries(r.body.paths).flatMap(([path, v]: any) => Object.keys(v).map((m) => `${m.toUpperCase()} ${path}`));
    expect(ops.sort()).toEqual(
      [
        'GET /public/products', 'POST /public/products', 'GET /public/products/by-barcode/{barcode}', 'PATCH /public/products/{id}', 'GET /public/prices',
        'GET /public/stock', 'GET /public/sales', 'GET /public/sales/{id}', 'POST /public/sales', 'GET /public/customers', 'GET /public/reports/daily',
      ].sort(),
    );
    expect(r.body.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(r.body['x-webhooks'].events).toEqual(expect.arrayContaining(['sale.created', 'stock.low', 'price.changed']));
    expect(r.body['x-changelog'][0].version).toBe('1.0.0');
    expect(JSON.stringify(r.body.paths['/public/products'].post)).toContain('Prices cannot be set here');
    expect((await api().get(`${P}/docs/changelog`)).body.data).toHaveLength(1);
  });
});

/* ========================================================================== webhooks */

describe('webhooks (spec 10.4)', () => {
  let server: http.Server;
  let url: string;
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  let respond = 200;
  beforeEach(async () => {
    received.length = 0;
    respond = 200;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respond;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterEach(async () => void (await new Promise((r) => server.close(r))));

  async function hook(t: Ctx, evs = ['sale.created', 'sale.refunded', 'stock.low', 'shift.closed']) {
    const r = await t.post('/webhooks', { url, events: evs });
    expect(r.status).toBe(201);
    return { id: r.body.data.id as string, secret: r.body.data.secret as string };
  }

  it('delivers signed events for sales; the secret is shown once and stored encrypted', async () => {
    const t = await posCtx();
    const w = await hook(t);
    expect(w.secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await t.get('/webhooks')).body)).not.toContain(w.secret);
    expect(JSON.stringify(await Webhook.findOne({ shopId: t.shop.shopId }).lean())).not.toContain(w.secret);

    const sale = (await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }])).body.data;
    await waitFor(async () => (await WebhookDelivery.countDocuments({ shopId: t.shop.shopId })) >= 1);
    expect(await deliverDue()).toBe(1);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers['x-kass-event']).toBe('sale.created');
    const expected = crypto.createHmac('sha256', w.secret).update(`${headers['x-kass-timestamp']}.${body}`).digest('hex');
    expect(headers['x-kass-signature']).toBe(`sha256=${expected}`);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ event: 'sale.created', data: { id: sale.id, number: '1-000001', total: COLA.price } });
    expect(payload.id).toBe(headers['x-kass-delivery']);
    const log = (await t.get(`/webhooks/${w.id}/deliveries`)).body.data;
    expect(log[0]).toMatchObject({ status: 'delivered', attempts: 1, lastStatusCode: 200, event: 'sale.created' });
  });

  it('only sends subscribed events of active endpoints, and never mixes shops', async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    const w = await hook(a, ['shift.closed']);
    await hook(b, ['sale.created']);
    await a.sell([{ productId: a.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    await sleep(150);
    expect(await WebhookDelivery.countDocuments({ shopId: a.shop.shopId })).toBe(0); // not subscribed to sale.created
    await a.post(`/shifts/${a.shiftId}/close`, { countedCash: 1_300_000 }, a.cashier.h);
    await waitFor(async () => (await WebhookDelivery.countDocuments({ shopId: a.shop.shopId })) === 1);
    expect(await WebhookDelivery.countDocuments({ shopId: b.shop.shopId })).toBe(0);
    await a.patch(`/webhooks/${w.id}`, { isActive: false });
    await a.post('/shifts/open', { terminalId: a.term.id, openingCash: 0 }, a.cashier.h);
    expect(await WebhookDelivery.countDocuments({ shopId: a.shop.shopId })).toBe(1);
    expect((await b.get(`/webhooks/${w.id}/deliveries`)).status).toBe(404);
    expect((await b.patch(`/webhooks/${w.id}`, { isActive: true })).status).toBe(404);
  });

  it('retries with exponential backoff and gives up after 24 hours', async () => {
    const t = await posCtx();
    await hook(t, ['sale.created']);
    respond = 500;
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    await waitFor(async () => (await WebhookDelivery.countDocuments({ shopId: t.shop.shopId })) === 1);
    await deliverDue();
    let d = (await WebhookDelivery.findOne({ shopId: t.shop.shopId }))!;
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500 });
    const gap1 = d.nextAttemptAt.getTime() - Date.now();
    expect(gap1).toBeGreaterThan(20_000);
    expect(gap1).toBeLessThanOrEqual(31_000);
    expect(await deliverDue()).toBe(0); // not due yet

    await WebhookDelivery.updateOne({ _id: d._id, shopId: t.shop.shopId }, { nextAttemptAt: new Date() });
    await deliverDue();
    d = (await WebhookDelivery.findOne({ shopId: t.shop.shopId }))!;
    expect(d.attempts).toBe(2);
    expect(d.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50_000); // doubled: ~60 s

    respond = 200;
    await WebhookDelivery.updateOne({ _id: d._id, shopId: t.shop.shopId }, { nextAttemptAt: new Date() });
    await deliverDue();
    expect((await WebhookDelivery.findOne({ shopId: t.shop.shopId }))!).toMatchObject({ status: 'delivered', attempts: 3 });

    // an endpoint that never recovers is abandoned after 24 h
    respond = 500;
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    const d2 = await waitFor(async () => (await WebhookDelivery.findOne({ shopId: t.shop.shopId, status: 'pending' })) ?? false);
    await WebhookDelivery.updateOne({ _id: d2._id, shopId: t.shop.shopId }, { expiresAt: new Date(Date.now() - 1000) });
    await deliverDue();
    expect((await WebhookDelivery.findOne({ _id: d2._id, shopId: t.shop.shopId }))!.status).toBe('failed');
  });

  it('sends a signed test ping on demand', async () => {
    const t = await posCtx();
    const w = await hook(t);
    const r = await t.post(`/webhooks/${w.id}/test`, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ event: 'ping', status: 'delivered' });
    expect(received[0].headers['x-kass-event']).toBe('ping');
  });

  it('blocks webhook URLs that point at the internal network (SSRF)', async () => {
    const t = await posCtx();
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'false';
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/hook', 'http://127.0.0.1:27017', 'http://localhost/hook', 'http://[::1]/x', 'ftp://example.com/x', 'file:///etc/passwd', 'not a url', 'http://user:pw@example.com/x']) {
      const r = await t.post('/webhooks', { url: bad, events: ['sale.created'] });
      expect(r.status, bad).toBe(400);
    }
    expect((await t.get('/webhooks')).body.data).toHaveLength(0);
    // a webhook that later resolves to a private address is refused at delivery time too
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
    const w = await hook(t, ['sale.created']);
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'false';
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    await waitFor(async () => (await WebhookDelivery.countDocuments({ shopId: t.shop.shopId })) === 1);
    await deliverDue();
    expect(received).toHaveLength(0);
    expect((await WebhookDelivery.findOne({ shopId: t.shop.shopId }))!.lastError).toBeTruthy();
    expect(w.id).toBeTruthy();
  });

  it('only the shop admin manages webhooks; price changes and low stock are announced', async () => {
    const t = await posCtx();
    expect((await t.post('/webhooks', { url, events: ['sale.created'] }, t.manager.h)).status).toBe(403);
    await hook(t, ['price.changed', 'stock.low']);
    await t.put('/prices', { changes: [{ productId: t.cola.id, branchId: t.shop.branchId, price: 1_250_000 }] });
    await t.put('/stock/min-stock', { branchId: t.shop.branchId, items: [{ productId: t.bread.id, minStock: 99 }] });
    await t.sell([{ productId: t.bread.id, qty: 2 }], [{ method: 'cash', amount: 600_000 }]);
    await waitFor(async () => (await WebhookDelivery.countDocuments({ shopId: t.shop.shopId })) >= 2);
    await deliverDue();
    const names = received.map((r) => JSON.parse(r.body).event).sort();
    expect(names).toEqual(['price.changed', 'stock.low']);
  });
});

/* ========================================================================== telegram */

describe('Telegram notifications (spec 11.4, 4.6)', () => {
  const webhook = (secret: string, chatId: number, text: string, lang = 'en') =>
    api().post(`${P}/telegram/webhook/${secret}`).send({ message: { chat: { id: chatId }, text, from: { language_code: lang, username: 'owner' } } });

  async function link(t: Ctx, chatId = 111, auth = t.A) {
    const l = await api().post(`${P}/telegram/link`).set(auth).send({});
    expect(l.status).toBe(200);
    expect(l.body.data.token).toBeTruthy();
    expect((await webhook('dev-webhook-secret', chatId, `/start ${l.body.data.token}`)).status).toBe(200);
    return l.body.data.token as string;
  }

  it('links an account with a one-time link; several recipients per shop; links cannot be reused', async () => {
    const t = await posCtx();
    const token = await link(t, 111);
    expect(sent[0]).toMatchObject({ chatId: '111' });
    expect(sent[0].text).toContain('✅');
    const list = (await t.get('/telegram/recipients')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ chatId: '111', language: 'uz', userName: expect.any(String) });
    expect(list[0].notifications.dailySummary).toMatchObject({ enabled: true, time: '21:00' });
    await link(t, 222);
    expect((await t.get('/telegram/recipients')).body.data).toHaveLength(2);

    sent.length = 0;
    await webhook('dev-webhook-secret', 333, `/start ${token}`);
    expect(sent[0].text).toMatch(/invalid|expired/i); // the token was already used
    expect((await t.get('/telegram/recipients')).body.data).toHaveLength(2);
    expect((await webhook('wrong-secret', 1, '/start x')).status).toBe(403);
    expect((await t.post('/telegram/link', {}, t.manager.h)).status).toBe(403);
  });

  it('/stop switches notifications off for the chat', async () => {
    const t = await posCtx();
    await link(t, 555);
    await webhook('dev-webhook-secret', 555, '/stop');
    expect(await TelegramRecipient.countDocuments({ shopId: t.shop.shopId })).toBe(0);
  });

  it('sends the shift-closed message with the cash difference, in the recipient language', async () => {
    const t = await posCtx();
    await link(t, 111);
    const r = (await t.get('/telegram/recipients')).body.data[0];
    await t.patch(`/telegram/recipients/${r.id}`, { language: 'ru' });
    sent.length = 0;
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    await t.post(`/shifts/${t.shiftId}/close`, { countedCash: 1_250_000 }, t.cashier.h);
    const msg = await waitFor(() => sent.find((m) => m.text.includes('Смена закрыта')));
    expect(msg.text).toContain('Расхождение: -500');
    expect(msg.text).toContain('Ожидалось: 13 000 сум');
  });

  it('refund alerts only above the threshold; low and negative stock alerts; each can be switched off', async () => {
    const t = await posCtx({ cashierPerms: ['sales.refund'] });
    await link(t, 111);
    const r = (await t.get('/telegram/recipients')).body.data[0];
    await t.patch(`/telegram/recipients/${r.id}`, { notifications: { refundAbove: { amount: 1_000_000 } } });
    const sale = (await t.sell([{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 2_700_000 }])).body.data;
    sent.length = 0;
    await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'small', lines: [{ productId: t.bread.id, qty: 1 }] }, t.cashier.h); // 300 000 < 1 000 000
    await sleep(150);
    expect(sent).toHaveLength(0);
    await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'big', lines: [{ productId: t.cola.id, qty: 2 }] }, t.cashier.h); // 2 400 000
    expect((await waitFor(() => sent.find((m) => m.text.startsWith('↩️')))).text).toContain('R-000002');

    // negative stock (default 100 colas - sold - returned...)
    sent.length = 0;
    await t.sell([{ productId: t.bread.id, qty: 150 }], [{ method: 'cash', amount: 150 * 300_000 }]);
    expect((await waitFor(() => sent.find((m) => m.text.startsWith('❗')))).text).toContain('Bread');
    await t.patch(`/telegram/recipients/${r.id}`, { notifications: { negativeStock: false } });
    sent.length = 0;
    await t.sell([{ productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 300_000 }]);
    await sleep(150);
    expect(sent.filter((m) => m.text.startsWith('❗'))).toHaveLength(0);

    await t.put('/stock/min-stock', { branchId: t.shop.branchId, items: [{ productId: t.cola.id, minStock: 99 }] });
    sent.length = 0;
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    expect((await waitFor(() => sent.find((m) => m.text.startsWith('⚠️')))).text).toContain('Cola 1L');
  });

  it('daily summary at the chosen time, once per day', async () => {
    const t = await posCtx();
    await link(t, 111);
    await t.sell([{ productId: t.cola.id, qty: 2 }], [{ method: 'cash', amount: 2 * COLA.price }]);
    sent.length = 0;
    // h:m on today's Tashkent calendar day (UTC+5); using the UTC date would pick yesterday between 00:00 and 05:00 in Tashkent
    const tashkentNow = (h: number, m: number) => {
      const day = new Date(Date.now() + 5 * 3600_000);
      return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h - 5, m));
    };
    expect(await dailySummaryJob(tashkentNow(20, 59))).toBe(0); // before 21:00
    expect(await dailySummaryJob(tashkentNow(21, 0))).toBe(1);
    expect(sent[0].text).toContain('24 000'); // Uzbek default: "24 000 so'm"
    expect(sent[0].text).toContain('Cheklar: 1');
    expect(await dailySummaryJob(tashkentNow(21, 5))).toBe(0); // already sent today
    const r = (await t.get('/telegram/recipients')).body.data[0];
    await t.patch(`/telegram/recipients/${r.id}`, { notifications: { dailySummary: { time: '08:00' } } });
    await TelegramRecipient.updateOne({ _id: r.id, shopId: t.shop.shopId }, { lastDailySummaryDate: '2000-01-01' });
    expect(await dailySummaryJob(tashkentNow(9, 0))).toBe(1);
  });

  it('reports shifts open too long, overdue customer debts and expiring subscriptions', async () => {
    const t = await posCtx();
    await link(t, 111);
    const { Shift } = await import('../src/models/sales');
    await Shift.updateOne({ _id: t.shiftId, shopId: t.shop.shopId }, { openedAt: new Date(Date.now() - 30 * 3600_000) });
    sent.length = 0;
    expect(await longShiftJob()).toBe(1);
    expect((await waitFor(() => sent.find((m) => m.text.startsWith('⏰')))).text).toContain('30');
    expect(await longShiftJob()).toBe(0); // reported once

    const c = (await t.post('/customers', { fullName: 'Late payer', phone: '+998 90 000 77 77' }, t.cashier.h)).body.data;
    const { Customer } = await import('../src/models/sales');
    await Customer.updateOne({ _id: c.id, shopId: t.shop.shopId }, { debtBalance: 750_000, debtSince: new Date(Date.now() - 40 * 86_400_000) });
    sent.length = 0;
    const eleven = new Date(); eleven.setUTCHours(6, 0, 0, 0); // 11:00 Tashkent
    expect(await debtReminderJob(eleven)).toBe(1);
    expect(sent[0].text).toContain('1');
    expect(sent[0].text).toContain('7 500');

    await Shop.updateOne({ _id: t.shop.shopId }, { paidUntil: new Date(Date.now() + 2 * 86_400_000) });
    sent.length = 0;
    expect(await expiryNoticeJob()).toBe(1);
    await waitFor(() => sent.find((m) => m.text.includes('📅')));
    expect(await expiryNoticeJob()).toBe(0); // once a day
  });

  it('alerts the superadmin about expiring and expired shops', async () => {
    const t = await posCtx();
    const l = await api().post(`${P}/admin/telegram/link`).set(bearer(t.sa.token)).send({});
    await webhook('dev-webhook-secret', 999, `/start ${l.body.data.token}`);
    expect(sent[0].text).toContain('✅');
    await link(t, 111);
    await Shop.updateOne({ _id: t.shop.shopId }, { paidUntil: new Date(Date.now() + 2 * 86_400_000) });
    sent.length = 0;
    await expiryNoticeJob();
    await waitFor(() => sent.find((m) => m.chatId === '999' && m.text.includes('📅')));
    sent.length = 0;
    await Shop.updateOne({ _id: t.shop.shopId }, { paidUntil: new Date(Date.now() - 10 * 86_400_000) });
    expect(await expireShops()).toBe(1);
    await waitFor(() => sent.find((m) => m.chatId === '999' && m.text.includes('⛔')));
    expect(sent.some((m) => m.chatId === '111' && m.text.includes('⛔'))).toBe(false); // platform-only message
  });

  it('test message, recipient removal and tenant isolation', async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    await link(a, 111);
    sent.length = 0;
    expect((await a.post('/telegram/test', {})).body.data.sent).toBe(1);
    expect(sent[0].chatId).toBe('111');
    const id = (await a.get('/telegram/recipients')).body.data[0].id;
    expect((await b.get('/telegram/recipients')).body.data).toHaveLength(0);
    expect((await api().delete(`${P}/telegram/recipients/${id}`).set(b.A)).status).toBe(404);
    expect((await api().delete(`${P}/telegram/recipients/${id}`).set(a.A)).status).toBe(200);
    expect(await TelegramRecipient.countDocuments({ shopId: a.shop.shopId })).toBe(0);
  });
});

/* ========================================================================== audit log */

describe('shop audit log (spec 2.1, 14.1)', () => {
  it('records prices, refunds, discount approvals, staff and settings changes; only the admin reads it', async () => {
    const t = await posCtx({ cashierPerms: ['sales.refund'] });
    await t.put('/prices', { changes: [{ productId: t.cola.id, branchId: t.shop.branchId, price: 1_300_000 }] });
    await t.patch('/settings', { maxCashierDiscount: 3 });
    const sale = (await t.sell([{ productId: t.cola.id, qty: 1, discount: 200_000 }], [{ method: 'cash', amount: 1_300_000 }], { approval: { login: t.manager.login, pin: '9999' } })).body.data;
    await t.post('/refunds', { saleId: sale.id, method: 'cash', reason: 'audit me', lines: [{ productId: t.cola.id, qty: 1 }] }, t.cashier.h);
    const actions = (await t.get('/audit-logs?limit=100')).body.data.map((l: any) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['prices.changed', 'settings.updated', 'sale.discount_approved', 'refund.created', 'staff.created', 'auth.login', 'shift.opened']));
    expect((await t.get('/audit-logs?action=prices.changed')).body.data).toHaveLength(2); // initial price list + this change
    expect((await t.get('/audit-logs', t.manager.h)).status).toBe(403);
    expect((await t.get('/audit-logs', t.cashier.h)).status).toBe(403);
    const price = (await t.get('/audit-logs?action=prices.changed')).body.data[0];
    expect(price.meta.sample[0]).toMatchObject({ oldPrice: COLA.price, newPrice: 1_300_000 });
  });

  it('never exposes secrets or other shops/platform entries', async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    await a.post('/api-keys', { name: 'Secret key', scopes: ['products:read'] });
    const text = JSON.stringify((await a.get('/audit-logs?limit=100')).body);
    expect(text).not.toMatch(/\$2[aby]\$|kk_live_[\w-]{20,}/); // no bcrypt hashes, no API keys
    expect(text).not.toMatch(/"passwordHash":"(?!\[REDACTED\])/);
    const shopsInLog = new Set((await a.get('/audit-logs?limit=100')).body.data.map((l: any) => l.shopId));
    expect([...shopsInLog]).toEqual([a.shop.shopId]);
    expect((await b.get('/audit-logs?limit=100')).body.data.every((l: any) => l.shopId === b.shop.shopId)).toBe(true);
    expect(await AuditLog.countDocuments({ shopId: null })).toBeGreaterThan(0); // platform entries exist but stay invisible to shops
  });
});
