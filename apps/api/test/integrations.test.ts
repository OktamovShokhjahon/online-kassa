import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { events } from '../src/lib/events';
import { MockFiscalProvider } from '../src/lib/fiscal/mock';
import { Shop, Terminal } from '../src/models/core';
import { Customer, FiscalLog, Sale, Shift } from '../src/models/sales';
import { Stock } from '../src/models/stock';
import { agentHub } from '../src/modules/agent/hub';
import { P, api, app, bearer } from './helpers';
import { COLA, posCtx } from './posCtx';

beforeEach(() => {
  events.clear();
  MockFiscalProvider.issued.length = 0;
  process.env.FISCAL_TIMEOUT_MS = '10000';
});

/* ------------------------------------------------------------------------ fiscal */

async function fiscalShop(credentials: Record<string, unknown> = {}, provider = 'mock') {
  const t = await posCtx({ shop: { fiscalEnabled: true, tin: '123456789' }, openShift: false });
  const configure = (creds: Record<string, unknown> = credentials, prov = provider) =>
    api().put(`${P}/admin/shops/${t.shop.shopId}/terminals/${t.term.id}/fiscal`).set(bearer(t.sa.token)).send({ provider: prov, moduleId: 'MOD-77', credentials: creds });
  await configure();
  const open = await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.cashier.h);
  expect(open.status).toBe(201);
  const body = (extra: Record<string, unknown> = {}) => t.body([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { shiftId: open.body.data.id, ...extra });
  return { t, configure, shiftId: open.body.data.id as string, body, open };
}
const stock = async (t: any, id: string) => (await Stock.findOne({ shopId: t.shop.shopId, productId: id }).lean())!.quantity;

describe('fiscal receipts (spec 8)', () => {
  it('a fiscal shop cannot open a shift until the terminal has a fiscal module', async () => {
    const t = await posCtx({ shop: { fiscalEnabled: true, tin: '123456789' }, openShift: false });
    const r = await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.cashier.h);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('FISCAL_NOT_CONFIGURED');
    expect(await Shift.countDocuments({ shopId: t.shop.shopId })).toBe(0); // nothing left half-open
  });

  it('every sale carries fiscal data, which also reaches the printed receipt; shifts are opened and closed in the module', async () => {
    const { t, shiftId, body } = await fiscalShop();
    expect((await Shift.findOne({ _id: shiftId, shopId: t.shop.shopId }))!.fiscalShiftId).toMatch(/^MOCK-SHIFT-/);
    const r = await t.post('/sales', body(), t.cashier.h);
    expect(r.status).toBe(201);
    expect(r.body.data.fiscal).toMatchObject({ status: 'registered', moduleId: 'MOD-77' });
    expect(r.body.data.fiscal.sign).toMatch(/^\d{12}$/);
    expect(r.body.data.receipt.fiscal).toMatchObject({ sign: r.body.data.fiscal.sign, moduleId: 'MOD-77' });
    expect(r.body.data.receipt.fiscal.qr).toContain('https://');
    expect(r.body.data.lines[0]).toMatchObject({ mxikCode: '12345678901234567', packageCode: '1500' });

    await t.post(`/shifts/${shiftId}/close`, { countedCash: COLA.price }, t.cashier.h);
    const logs = (await t.get('/fiscal/logs')).body.data;
    expect(logs.map((l: any) => l.docType).sort()).toEqual(['close_shift', 'open_shift', 'sale']);
    expect(logs.every((l: any) => l.status === 'ok')).toBe(true);
  });

  it('refuses to sell products without MXIK or package codes', async () => {
    const { t, body } = await fiscalShop();
    const bare = await t.product({ name: 'No codes' });
    await t.receive(t.shop.branchId, t.supplierId, [[bare.id, 5, 100]]);
    await t.put('/prices', { changes: [{ productId: bare.id, branchId: t.shop.branchId, price: 500_000 }] });
    const r = await t.post('/sales', body({ lines: [{ productId: bare.id, qty: 1 }], payments: [{ method: 'cash', amount: 500_000 }] }), t.cashier.h);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('FISCAL_MISSING_CODES');
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect(MockFiscalProvider.issued).toHaveLength(0);
    // the panel lists such products
    expect((await t.get('/products?missingMxik=true')).body.data.map((p: any) => p.name)).toContain('No codes');
  });

  it('if the fiscal module fails the sale is NOT completed: no sale, no stock change; retry works', async () => {
    const { t, configure, body } = await fiscalShop();
    await configure({ fail: true });
    const payload = body();
    const r = await t.post('/sales', payload, t.cashier.h);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('FISCAL_ERROR');
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect(await stock(t, t.cola.id)).toBe(100);
    expect((await FiscalLog.find({ shopId: t.shop.shopId, docType: 'sale' }).lean())[0]).toMatchObject({ status: 'error' });

    await configure({});
    const retry = await t.post('/sales', payload, t.cashier.h); // same clientRequestId
    expect(retry.status).toBe(201);
    expect(await stock(t, t.cola.id)).toBe(99);
    expect(MockFiscalProvider.issued.filter((x) => x.kind === 'sale')).toHaveLength(1);
  });

  it('times out after the configured limit (default 10 s) and logs it', async () => {
    const { t, configure, body } = await fiscalShop();
    process.env.FISCAL_TIMEOUT_MS = '200';
    await configure({ delayMs: 1500 });
    const started = Date.now();
    const r = await t.post('/sales', body(), t.cashier.h);
    expect(Date.now() - started).toBeLessThan(1400);
    expect(r.status).toBe(502);
    expect(r.body.error.details).toEqual({ reason: 'timeout' });
    expect((await FiscalLog.findOne({ shopId: t.shop.shopId, docType: 'sale' }).lean())!.status).toBe('timeout');
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
  });

  it('refunds are fiscalized as linked refund receipts; a refund that fails changes nothing', async () => {
    const { t, configure, body } = await fiscalShop();
    const sale = (await t.post('/sales', body(), t.cashier.h)).body.data;
    const approval = { login: t.manager.login, pin: '9999' };
    const req = { saleId: sale.id, method: 'cash', reason: 'defect', lines: [{ productId: t.cola.id, qty: 1 }], approval };

    await configure({ failRefund: true });
    const bad = await t.post('/refunds', req, t.cashier.h);
    expect(bad.status).toBe(502);
    expect((await Sale.findOne({ shopId: t.shop.shopId }))!.status).toBe('completed');
    expect(await stock(t, t.cola.id)).toBe(99);

    await configure({});
    const ok = await t.post('/refunds', req, t.cashier.h);
    expect(ok.status).toBe(201);
    expect(ok.body.data.fiscal.sign).toMatch(/^\d{12}$/);
    expect(ok.body.data.receipt.fiscal).toBeTruthy();
    expect(MockFiscalProvider.issued.filter((x) => x.kind === 'refund')).toHaveLength(1);
    expect(await stock(t, t.cola.id)).toBe(100);
  });

  it('offline sales are allowed only when the provider supports offline fiscalization', async () => {
    const { t, configure, body } = await fiscalShop();
    const off = (extra: Record<string, unknown> = {}) => body({ isOffline: true, createdAt: new Date(Date.now() - 60_000).toISOString(), lines: [{ productId: t.cola.id, qty: 1, price: COLA.price }], ...extra });
    const ok = await t.post('/sales/sync', { sales: [off()] }, t.cashier.h);
    expect(ok.body.data[0].status).toBe('created');
    expect(ok.body.data[0].conflicts).toEqual([]);
    await configure({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, 'http-json');
    const blocked = await t.post('/sales/sync', { sales: [off()] }, t.cashier.h);
    expect(blocked.body.data[0]).toMatchObject({ status: 'error', error: { code: 'OFFLINE_NOT_ALLOWED' } });
  });

  it('credentials are encrypted at rest and never appear in logs or API responses', async () => {
    const { t, body } = await fiscalShop({ apiKey: 'SECRET-KEY-123', token: 'TOPSECRET' });
    await t.post('/sales', body(), t.cashier.h);
    const stored = (await Terminal.findOne({ _id: t.term.id, shopId: t.shop.shopId }).lean())!;
    expect(JSON.stringify(stored)).not.toContain('SECRET-KEY-123');
    expect(stored.fiscal!.credentialsEncrypted).toBeTruthy();
    const logs = JSON.stringify(await FiscalLog.find({ shopId: t.shop.shopId }).lean());
    expect(logs).not.toContain('SECRET-KEY-123');
    expect(logs).not.toContain('TOPSECRET');
    expect(JSON.stringify((await t.get('/terminals')).body)).not.toContain('SECRET');
    expect(JSON.stringify((await api().get(`${P}/admin/shops/${t.shop.shopId}`).set(bearer(t.sa.token))).body)).not.toContain('SECRET');
  });

  it('only the superadmin configures terminal fiscal settings; unknown providers are rejected', async () => {
    const { t } = await fiscalShop();
    const attempt = await api().put(`${P}/admin/shops/${t.shop.shopId}/terminals/${t.term.id}/fiscal`).set(t.A).send({ provider: 'mock', credentials: {} });
    expect(attempt.status).toBe(403);
    const unknown = await api().put(`${P}/admin/shops/${t.shop.shopId}/terminals/${t.term.id}/fiscal`).set(bearer(t.sa.token)).send({ provider: 'nope', credentials: {} });
    expect(unknown.status).toBe(400);
    expect((await api().get(`${P}/admin/fiscal-providers`).set(bearer(t.sa.token))).body.data).toEqual(expect.arrayContaining(['mock', 'http-json']));
  });

  it('reports the module status for the POS, including unreachable modules', async () => {
    const { t, configure } = await fiscalShop();
    expect((await t.get(`/fiscal/status/${t.term.id}`, t.cashier.h)).body.data).toMatchObject({ fiscalEnabled: true, configured: true, online: true });
    await configure({ fail: true });
    expect((await t.get(`/fiscal/status/${t.term.id}`, t.cashier.h)).body.data).toMatchObject({ online: false });
  });

  it('switching fiscal off keeps earlier fiscal data; non-fiscal shops never touch the module', async () => {
    const { t, body } = await fiscalShop();
    const fiscalSale = (await t.post('/sales', body(), t.cashier.h)).body.data;
    await api().patch(`${P}/admin/shops/${t.shop.shopId}/fiscal`).set(bearer(t.sa.token)).send({ fiscalEnabled: false }).expect(200);
    const plain = await t.post('/sales', body(), t.cashier.h);
    expect(plain.status).toBe(201);
    expect(plain.body.data.fiscal?.sign).toBeUndefined();
    expect(plain.body.data.receipt.fiscal).toBeNull();
    expect((await Sale.findOne({ shopId: t.shop.shopId, _id: fiscalSale.id }))!.fiscal!.sign).toBe(fiscalSale.fiscal.sign);
    expect(MockFiscalProvider.issued.filter((x) => x.kind === 'sale')).toHaveLength(1);

    const nf = await posCtx({ sa: t.sa });
    await nf.sell([{ productId: nf.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    expect(await FiscalLog.countDocuments({ shopId: nf.shop.shopId })).toBe(0);
    expect((await nf.get(`/fiscal/status/${nf.term.id}`, nf.cashier.h)).body.data).toEqual({ fiscalEnabled: false });
  });
});

/* -------------------------------------------------------------------------- agent */

describe('local agent (spec 9)', () => {
  async function paired(opts: { sa?: { token: string } } = {}) {
    const t = await posCtx({ openShift: false, ...opts });
    const code = (await t.post(`/terminals/${t.term.id}/pairing-code`, {})).body.data.code as string;
    const pair = await api().post(`${P}/agent/pair`).send({ code, machineId: 'PC-MACHINE-01', version: '1.0.0' });
    return { t, code, pair, token: pair.body.data?.token as string, secret: pair.body.data?.sessionSecret as string };
  }

  it('pairs with a 6-digit code once; the code is single-use and expires', async () => {
    const { t, code, pair } = await paired();
    expect(pair.status).toBe(200);
    expect(pair.body.data).toMatchObject({ terminal: { id: t.term.id, name: 'Kassa 1' }, heartbeatSeconds: 30 });
    expect(pair.body.data.token).toMatch(/^kat_/);
    expect(pair.body.data.wsUrl).toMatch(/^ws:\/\/.+\/api\/v1\/agent\/ws$/);
    expect(pair.body.data.terminal.printerProfile).toMatchObject({ paperWidthMm: 58, charsPerLine: 32, codePage: 'CP866' });
    const term = (await Terminal.findOne({ _id: t.term.id, shopId: t.shop.shopId }).lean())!;
    expect(term.agentTokenHash).toBeTruthy();
    expect(JSON.stringify(term)).not.toContain(pair.body.data.token);
    expect(term.agentMachineId).toBe('PC-MACHINE-01');

    const reuse = await api().post(`${P}/agent/pair`).send({ code, machineId: 'PC-2' });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe('PAIRING_CODE_INVALID');

    const code2 = (await t.post(`/terminals/${t.term.id}/pairing-code`, {})).body.data.code;
    await Terminal.updateOne({ _id: t.term.id, shopId: t.shop.shopId }, { pairingExpiresAt: new Date(Date.now() - 1000) });
    expect((await api().post(`${P}/agent/pair`).send({ code: code2, machineId: 'PC-3' })).body.error.code).toBe('PAIRING_CODE_INVALID');
    expect((await api().post(`${P}/agent/pair`).send({ code: '12', machineId: 'PC-3' })).status).toBe(400);
  });

  it('the device token reads config and update info; revoking it ends access at once', async () => {
    const { t, token } = await paired();
    const cfg = await api().get(`${P}/agent/config`).set(bearer(token));
    expect(cfg.body.data.terminal.name).toBe('Kassa 1');
    await api().patch(`${P}/admin/settings`).set(bearer(t.sa.token)).send({ agentInstaller: { version: '1.4.0', url: 'https://dl.example/agent.exe' } });
    expect((await api().get(`${P}/agent/latest-version`).set(bearer(token))).body.data).toEqual({ version: '1.4.0', url: 'https://dl.example/agent.exe' });
    expect((await api().get(`${P}/agent/config`).set(bearer('kat_wrong'))).status).toBe(401);

    await api().delete(`${P}/terminals/${t.term.id}/agent`).set(t.A).expect(200);
    expect((await api().get(`${P}/agent/config`).set(bearer(token))).status).toBe(401);
  });

  it('a blocked shop cuts off its agents and cannot pair new ones', async () => {
    const { t, token } = await paired();
    await api().post(`${P}/admin/shops/${t.shop.shopId}/block`).set(bearer(t.sa.token)).send({ reason: 'unpaid' }).expect(200);
    expect((await api().get(`${P}/agent/config`).set(bearer(token))).status).toBe(401); // token hash cleared on block
    const t2 = await posCtx({ openShift: false, sa: t.sa });
    const code = (await t2.post(`/terminals/${t2.term.id}/pairing-code`, {})).body.data.code;
    await api().post(`${P}/admin/shops/${t2.shop.shopId}/block`).set(bearer(t.sa.token)).send({ reason: 'unpaid' });
    expect((await api().post(`${P}/agent/pair`).send({ code, machineId: 'PC-9' })).status).toBeGreaterThanOrEqual(403);
  });

  it('issues POS session keys that the agent can verify offline with its pairing secret', async () => {
    const t = await posCtx({ openShift: false });
    const early = await t.post('/pos/agent-session', { terminalId: t.term.id }, t.cashier.h);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('TERMINAL_NOT_PAIRED');

    const code = (await t.post(`/terminals/${t.term.id}/pairing-code`, {})).body.data.code;
    const secret = (await api().post(`${P}/agent/pair`).send({ code, machineId: 'PC-1' })).body.data.sessionSecret;
    const r = await t.post('/pos/agent-session', { terminalId: t.term.id }, t.cashier.h);
    const [exp, mac] = r.body.data.sessionKey.split('.');
    expect(Number(exp)).toBeGreaterThan(Date.now());
    expect(crypto.createHmac('sha256', secret).update(`${t.term.id}.${exp}`).digest('base64url')).toBe(mac);
    // a different terminal or a tampered expiry does not verify
    expect(crypto.createHmac('sha256', secret).update(`${t.term.id}.${Number(exp) + 1}`).digest('base64url')).not.toBe(mac);
  });

  describe('WebSocket link', () => {
    let server: http.Server;
    let url: string;
    const sockets: WebSocket[] = [];
    beforeEach(async () => {
      server = http.createServer(app);
      agentHub.attach(server);
      await new Promise<void>((r) => server.listen(0, r));
      url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/agent/ws`;
    });
    afterEach(async () => {
      sockets.splice(0).forEach((s) => s.terminate());
      agentHub.close();
      await new Promise((r) => server.close(r));
    });

    const connect = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
        sockets.push(ws);
        ws.once('message', () => resolve(ws)); // the "hello" frame
        ws.once('error', reject);
        ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      });
    const nextMessage = (ws: WebSocket) => new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (code) => r(code)));

    it('rejects unknown tokens, accepts the device token, and records heartbeats', async () => {
      const { t, token } = await paired();
      await expect(connect('kat_nope')).rejects.toThrow('HTTP 401');
      const ws = await connect(token);
      expect(agentHub.isOnline(t.term.id)).toBe(true);
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'heartbeat', id: 'hb-1', payload: { version: '1.2.0', devices: { printer: 'online', scanner: 'ok' } } }));
      expect(await reply).toMatchObject({ type: 'ack', id: 'hb-1' });
      const term = (await Terminal.findOne({ _id: t.term.id, shopId: t.shop.shopId }).lean())!;
      expect(term.agentVersion).toBe('1.2.0');
      expect(term.deviceStatus).toEqual({ printer: 'online', scanner: 'ok' });
      expect((await t.get('/terminals')).body.data[0]).toMatchObject({ paired: true, online: true });
    });

    it('relays print jobs from the POS through the server to the agent and returns its answer', async () => {
      const { t, token } = await paired();
      const ws = await connect(token);
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'print.receipt') ws.send(JSON.stringify({ type: 'ack', id: m.id, payload: { printed: true, copies: m.payload.copies } }));
        if (m.type === 'print.test') ws.send(JSON.stringify({ type: 'error', id: m.id, payload: { code: 'NO_PAPER', message: 'Out of paper' } }));
      });
      const ok = await t.post('/pos/print', { terminalId: t.term.id, type: 'print.receipt', payload: { copies: 2, receipt: { number: '1-000001' } } }, t.cashier.h);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ printed: true, copies: 2 });
      const bad = await t.post('/pos/print', { terminalId: t.term.id, type: 'print.test', payload: {} }, t.cashier.h);
      expect(bad.status).toBe(502);
      expect(bad.body.error.code).toBe('PRINT_FAILED');
      expect(bad.body.error.details).toMatchObject({ code: 'NO_PAPER' });
    });

    it('reports AGENT_OFFLINE when no agent is connected, and disconnects revoked agents', async () => {
      const { t, token } = await paired();
      const off = await t.post('/pos/print', { terminalId: t.term.id, type: 'drawer.open', payload: {} }, t.cashier.h);
      expect(off.status).toBe(503);
      expect(off.body.error.code).toBe('AGENT_OFFLINE');
      const ws = await connect(token);
      const closing = closed(ws);
      await api().delete(`${P}/terminals/${t.term.id}/agent`).set(t.A).expect(200);
      expect(await closing).toBe(4001);
      expect(agentHub.isOnline(t.term.id)).toBe(false);
    });

    it('disconnects every agent of a shop when it is blocked', async () => {
      const { t, token } = await paired();
      const ws = await connect(token);
      const closing = closed(ws);
      await api().post(`${P}/admin/shops/${t.shop.shopId}/block`).set(bearer(t.sa.token)).send({ reason: 'unpaid' }).expect(200);
      expect(await closing).toBe(4001);
    });
  });
});

/* ------------------------------------------------------- customers & promotions */

describe('customers (spec 6.1)', () => {
  it('creates customers with unique phone and card; looks them up in any phone format', async () => {
    const t = await posCtx();
    const c = await t.post('/customers', { fullName: 'Bobur Karimov', phone: '90 123 45 67', cardBarcode: 'LOY-1', birthday: '1990-05-17' }, t.cashier.h);
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ phone: '+998901234567', bonusBalance: 0, debtBalance: 0 });
    expect((await t.post('/customers', { fullName: 'Other', phone: '+998 (90) 123-45-67' }, t.cashier.h)).body.error.code).toBe('DUPLICATE_PHONE');
    expect((await t.post('/customers', { fullName: 'Other', phone: '+998 91 000 00 00', cardBarcode: 'LOY-1' }, t.cashier.h)).body.error.code).toBe('DUPLICATE_CARD');
    expect((await t.get('/customers/by-phone/998901234567', t.cashier.h)).body.data.id).toBe(c.body.data.id);
    expect((await t.get('/customers/by-phone/%2B998%2090%20123%2045%2067', t.cashier.h)).body.data.id).toBe(c.body.data.id);
    expect((await t.get('/customers/by-card/LOY-1', t.cashier.h)).body.data.id).toBe(c.body.data.id);
    expect((await t.get('/customers/by-phone/12345', t.cashier.h)).status).toBe(404);
    expect((await t.get('/customers?q=bobur', t.cashier.h)).body.data).toHaveLength(1);
    expect((await t.get('/customers?q=1234', t.cashier.h)).body.data).toHaveLength(1);
  });

  it('only managers edit customers; history shows purchases and stats', async () => {
    const t = await posCtx();
    const c = (await t.post('/customers', { fullName: 'Hist User', phone: '+998 90 999 99 99' }, t.cashier.h)).body.data;
    expect((await t.patch(`/customers/${c.id}`, { fullName: 'Changed' }, t.cashier.h)).status).toBe(403);
    expect((await t.patch(`/customers/${c.id}`, { fullName: 'Changed Name' }, t.manager.h)).body.data.fullName).toBe('Changed Name');
    await t.sell([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { customerId: c.id });
    await t.sell([{ productId: t.cola.id, qty: 2 }], [{ method: 'cash', amount: 2 * COLA.price }], { customerId: c.id });
    const h = (await t.get(`/customers/${c.id}/history`, t.manager.h)).body.data;
    expect(h.stats).toMatchObject({ totalSpent: 3 * COLA.price, receipts: 2, averageReceipt: Math.round((3 * COLA.price) / 2) });
    expect(h.sales).toHaveLength(2);
    expect((await Customer.findOne({ _id: c.id, shopId: t.shop.shopId }))!.lastVisitAt).toBeTruthy();
  });

  it('customers are private to their shop', async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    const c = (await a.post('/customers', { fullName: 'Shared Phone', phone: '+998 90 000 11 22' }, a.cashier.h)).body.data;
    expect((await b.get(`/customers/${c.id}`, b.cashier.h)).status).toBe(404);
    expect((await b.get('/customers/by-phone/+998900001122', b.cashier.h)).status).toBe(404);
    expect((await b.post('/customers', { fullName: 'Same Phone', phone: '+998 90 000 11 22' }, b.cashier.h)).status).toBe(201); // unique per shop only
    expect((await b.sell([{ productId: b.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { customerId: c.id })).status).toBe(404);
  });
});

describe('promotions (spec 6.4)', () => {
  it('admin manages promotions; validation depends on the type; others cannot', async () => {
    const t = await posCtx();
    const create = (b: object, h = t.A) => t.post('/promotions', b, h);
    expect((await create({ name: 'Bundle without items', type: 'bundle', rules: { bundlePrice: 1000 } })).status).toBe(400);
    expect((await create({ name: 'No percent', type: 'percent', rules: {} })).status).toBe(400);
    expect((await create({ name: 'Bad window', type: 'percent', rules: { percent: 5 }, startsAt: '2026-12-01', endsAt: '2026-11-01' })).status).toBe(400);
    expect((await create({ name: 'Unknown product', type: 'percent', rules: { percent: 5, productIds: ['64b000000000000000000000'] } })).status).toBe(404);
    const combo = await create({ name: 'Combo', type: 'bundle', priority: 5, rules: { items: [{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 1 }], bundlePrice: 1_300_000 }, schedule: { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' } });
    expect(combo.status).toBe(201);
    expect((await create({ name: 'By cashier', type: 'percent', rules: { percent: 5 } }, t.cashier.h)).status).toBe(403);
    expect((await create({ name: 'By manager', type: 'percent', rules: { percent: 5 } }, t.manager.h)).status).toBe(403);
    expect((await t.get('/promotions', t.manager.h)).body.data).toHaveLength(1);
    const upd = await t.put(`/promotions/${combo.body.data.id}`, { name: 'Combo v2', type: 'bundle', rules: { items: [{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 1 }], bundlePrice: 1_250_000 }, isActive: false });
    expect(upd.body.data).toMatchObject({ name: 'Combo v2', isActive: false });
    expect((await api().delete(`${P}/promotions/${combo.body.data.id}`).set(t.A)).status).toBe(200);
    expect((await t.get(`/promotions/${combo.body.data.id}`)).status).toBe(404);
  });

  it('a bundle and a time-based promotion are applied by the sale engine', async () => {
    const t = await posCtx();
    await t.post('/promotions', { name: 'Combo', type: 'bundle', rules: { items: [{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 1 }], bundlePrice: 1_300_000 } });
    const r = await t.sell([{ productId: t.cola.id, qty: 1 }, { productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 1_500_000 }]);
    expect(r.body.data.total).toBe(1_300_000); // 1 500 000 -> 1 300 000
    expect(r.body.data.discount).toBe(200_000);
    // a promotion outside its time window does nothing
    await t.post('/promotions', { name: 'Never today', type: 'percent', rules: { percent: 50 }, endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    const after = await t.sell([{ productId: t.bread.id, qty: 1 }], [{ method: 'cash', amount: 300_000 }]);
    expect(after.body.data.total).toBe(300_000);
  });

  it('promotions of other shops never apply', async () => {
    const a = await posCtx();
    const b = await posCtx({ sa: a.sa });
    await a.post('/promotions', { name: 'A only', type: 'percent', rules: { percent: 50 } });
    const r = await b.sell([{ productId: b.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }]);
    expect(r.body.data.total).toBe(COLA.price);
    expect((await b.get('/promotions')).body.data).toHaveLength(0);
    expect(await Shop.countDocuments({})).toBe(2);
  });
});
