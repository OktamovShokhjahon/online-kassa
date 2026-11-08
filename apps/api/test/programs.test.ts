import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeCandidates } from '../src/modules/programs/desk';
import { pyLiteral } from '../src/modules/programs/admin';
import { Sale, Shift } from '../src/models/sales';
import { P, api, bearer } from './helpers';
import { BREAD, COLA, posCtx } from './posCtx';

type Ctx = Awaited<ReturnType<typeof posCtx>>;
const SA = (t: Ctx) => bearer(t.sa.token);

const deskBody = (t: Ctx, extra: Record<string, unknown> = {}) => ({
  terminalId: t.term.id,
  cashierId: t.cashier.id,
  apiUrl: 'http://localhost:3000/api/v1',
  language: 'ru',
  scanner: { port: 'COM3', baudrate: 9600 },
  printer: { type: 'file', paperMm: 80 },
  ...extra,
});

async function download(t: Ctx) {
  const r = await api().post(`${P}/admin/shops/${t.shop.shopId}/programs/desk`).set(SA(t)).send(deskBody(t));
  expect(r.status).toBe(201);
  const key = /"api_key": "(kk_live_[^"]+)"/.exec(r.body.data.content)![1];
  const d = (method: 'get' | 'post', p: string, body?: object) => {
    const req = api()[method](`${P}/desk${p}`).set(bearer(key));
    return body ? req.send(body) : req;
  };
  return { r, key, d };
}

describe('cash-desk program: download (superadmin Programs tab)', () => {
  it('writes the key and settings into the Python file and lists the program', async () => {
    const t = await posCtx({ openShift: false });
    const { r, key } = await download(t);
    const src: string = r.body.data.content;
    expect(r.body.data.filename).toBe('kassa_desk_kassa_1.py');
    expect(src).toContain('"api_url": "http://localhost:3000/api/v1"');
    expect(src).toContain('"terminal_name": "Kassa 1"');
    expect(src).toContain('"scanner": {"port": "COM3", "baudrate": 9600}');
    expect(src).toContain('"paper_mm": 80');
    expect(src).toContain('"fiscal": False');
    expect(src).toContain('class ScannerReader');
    expect(src.match(/^CONFIG = /gm)).toHaveLength(1);

    const list = (await api().get(`${P}/admin/shops/${t.shop.shopId}/programs`).set(SA(t))).body.data;
    expect(list.terminals.map((x: any) => x.name)).toContain('Kassa 1');
    expect(list.cashiers.map((x: any) => x.id)).toContain(t.cashier.id);
    expect(list.programs[0]).toMatchObject({ kind: 'desk', terminalName: 'Kassa 1', active: true });
    expect(JSON.stringify(list)).not.toContain(key);
  });

  it('is for the superadmin only and checks the terminal and cashier', async () => {
    const t = await posCtx({ openShift: false });
    const url = `${P}/admin/shops/${t.shop.shopId}/programs/desk`;
    expect((await api().post(url).set(t.A).send(deskBody(t))).status).toBe(403);
    expect((await api().post(url).set(SA(t)).send(deskBody(t, { terminalId: '64b000000000000000000000' }))).status).toBe(404);
    expect((await api().post(url).set(SA(t)).send(deskBody(t, { cashierId: '64b000000000000000000000' }))).status).toBe(404);
    expect((await api().post(url).set(SA(t)).send(deskBody(t, { apiUrl: 'not a url' }))).status).toBe(400);
  });

  it('the generated file is valid Python', async () => {
    const t = await posCtx({ openShift: false });
    const { r } = await download(t);
    const file = path.join(os.tmpdir(), `kassa_desk_${randomUUID()}.py`);
    fs.writeFileSync(file, r.body.data.content);
    let python: string | null = null;
    for (const cmd of ['python', 'python3']) {
      try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); python = cmd; break; } catch { /* try next */ }
    }
    if (!python) return; // no Python on this machine: syntax is checked where it exists
    execFileSync(python, ['-m', 'py_compile', file]);
    fs.rmSync(file, { force: true });
  });

  it('python literals', () => {
    expect(pyLiteral({ a: true, b: null, c: 'x"y\\z', d: [1, 'q'] })).toBe('{\n    "a": True,\n    "b": None,\n    "c": "x\\"y\\\\z",\n    "d": [1, "q"],\n}');
  });
});

describe('cash-desk program: selling', () => {
  it('opens a shift, sells by barcode with server prices, prints a receipt, closes with a Z-report', async () => {
    const t = await posCtx({ openShift: false });
    const { d } = await download(t);

    let s = (await d('get', '/session')).body.data;
    expect(s).toMatchObject({ shop: { currency: 'UZS' }, terminal: { name: 'Kassa 1' }, shift: null });
    const opened = await d('post', '/shift/open', { openingCash: 50_000_00 });
    expect(opened.status).toBe(201);
    expect((await d('post', '/shift/open', { openingCash: 0 })).body.error.code).toBe('SHIFT_ALREADY_OPEN');

    const catalog = (await d('get', '/catalog')).body.data;
    expect(catalog.find((p: any) => p.id === t.cola.id)).toMatchObject({ price: COLA.price, isMarked: false });
    const found = (await d('get', `/lookup?code=${t.cola.barcodes[0]}`)).body.data;
    expect(found.product.id).toBe(t.cola.id);
    expect((await d('get', '/lookup?code=000')).status).toBe(404);

    const q = (await d('post', '/quote', { lines: [{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }] })).body.data;
    expect(q.total).toBe(2 * COLA.price + BREAD.price);

    const sale = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'cash', cashGiven: 3_000_000, lines: [{ productId: t.cola.id, qty: 2 }, { productId: t.bread.id, qty: 1 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.sale).toMatchObject({ total: 2_700_000, cashGiven: 3_000_000, change: 300_000 });
    expect(sale.body.data.receipt).toMatchObject({ type: 'sale', total: 2_700_000, terminal: 'Kassa 1' });
    const saved = (await Sale.findOne({ _id: sale.body.data.sale.id, shopId: t.shop.shopId }).lean())!;
    expect(String(saved.cashierId)).toBe(t.cashier.id);
    expect(await t.stockOf(t.cola.id)).toMatchObject({ quantity: 98 });

    const card = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'card', lines: [{ productId: t.bread.id, qty: 1 }] });
    expect(card.body.data.sale.total).toBe(BREAD.price);
    expect((await d('post', '/sales', { clientRequestId: randomUUID(), method: 'cash', cashGiven: 100, lines: [{ productId: t.bread.id, qty: 1 }] })).body.error.code).toBe('PAYMENT_INSUFFICIENT');

    const x = (await d('get', '/shift/x-report')).body.data;
    expect(x.report.type).toBe('x_report');
    expect(x.totals.receipts).toBe(2);

    s = (await d('get', '/session')).body.data;
    const expected = s.shift.totals.expectedCash;
    expect(expected).toBe(50_000_00 + 2_700_000);
    const closed = await d('post', '/shift/close', { countedCash: expected });
    expect(closed.body.data.report).toMatchObject({ type: 'z_report', difference: 0 });
    expect(await Shift.countDocuments({ shopId: t.shop.shopId, status: 'open' })).toBe(0);
  });

  it('accepts offline sales once (idempotent) with the price that was charged', async () => {
    const t = await posCtx({ openShift: false });
    const { d } = await download(t);
    const shift = (await d('post', '/shift/open', { openingCash: 0 })).body.data;
    const body = { clientRequestId: randomUUID(), shiftId: shift.id, method: 'cash', cashGiven: 1_000_000, isOffline: true, createdAt: new Date(Date.now() - 60_000).toISOString(), localNumber: 'OFF-00001', lines: [{ productId: t.bread.id, qty: 2, price: 250_000 }] };
    const first = await d('post', '/sales', body);
    expect(first.status).toBe(201);
    expect(first.body.data.sale).toMatchObject({ total: 500_000, change: 500_000, isOffline: true });
    const again = await d('post', '/sales', body);
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
  });

  it('a revoked or ordinary key cannot use the desk API', async () => {
    const t = await posCtx({ openShift: false });
    const { d, r } = await download(t);
    const normal = (await t.post('/api-keys', { name: 'ERP', scopes: ['products:read'] })).body.data.key;
    expect((await api().get(`${P}/desk/session`).set(bearer(normal))).body.error.code).toBe('PROGRAM_KEY_REQUIRED');
    // and the program key cannot read the public API
    const key = /"api_key": "(kk_live_[^"]+)"/.exec(r.body.data.content)![1];
    expect((await api().get(`${P}/public/products`).set(bearer(key))).body.error.code).toBe('SCOPE_MISSING');
    expect((await api().delete(`${P}/admin/shops/${t.shop.shopId}/programs/${r.body.data.program.id}`).set(SA(t))).status).toBe(200);
    expect((await d('get', '/session')).status).toBe(401);
  });
});

describe('cash-desk program: shifts run themselves', () => {
  it('the first sale opens the shift; a new day closes the old one and opens a new one; no long-shift alert', async () => {
    const t = await posCtx({ openShift: false });
    const { d } = await download(t);
    expect((await d('get', '/session')).body.data.shift).toBeNull();

    // no "open shift" step: the sale just works
    const first = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'cash', lines: [{ productId: t.bread.id, qty: 1 }] });
    expect(first.status).toBe(201);
    const s1 = (await Shift.findOne({ shopId: t.shop.shopId, status: 'open' }).lean())!;
    expect(s1).toMatchObject({ autoManaged: true, openingCash: 0 });
    expect(String(s1.cashierId)).toBe(t.cashier.id);
    const second = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'card', lines: [{ productId: t.cola.id, qty: 1 }] });
    expect(second.status).toBe(201);
    expect(await Shift.countDocuments({ shopId: t.shop.shopId })).toBe(1);
    expect((await d('get', '/session')).body.data.shift.totals.receipts).toBe(2);

    // the shift is old enough for a long-shift alert, but it is the program's own: none is sent
    const { longShiftJob } = await import('../src/modules/telegram/notifier');
    await Shift.updateOne({ _id: s1._id, shopId: t.shop.shopId }, { openedAt: new Date(Date.now() - 30 * 3600_000) });
    expect(await longShiftJob()).toBe(0);

    // that shift started yesterday: the next sale closes it (counted = expected) and opens today's
    const third = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'cash', lines: [{ productId: t.bread.id, qty: 2 }] });
    expect(third.status).toBe(201);
    const old = (await Shift.findOne({ _id: s1._id, shopId: t.shop.shopId }).lean())!;
    expect(old).toMatchObject({ status: 'closed', difference: 0 });
    expect((old.totals as any).receipts).toBe(2);
    const today = (await Shift.findOne({ shopId: t.shop.shopId, status: 'open' }).lean())!;
    expect(String(today._id)).not.toBe(String(s1._id));
    expect((await d('get', '/session')).body.data.shift.totals.receipts).toBe(1);
  });

  it('never closes a shift opened by hand on the web POS', async () => {
    const t = await posCtx(); // the cashier opened a shift in the web POS
    const { d } = await download(t);
    await Shift.updateOne({ _id: t.shiftId, shopId: t.shop.shopId }, { openedAt: new Date(Date.now() - 30 * 3600_000) });
    const sale = await d('post', '/sales', { clientRequestId: randomUUID(), method: 'cash', lines: [{ productId: t.bread.id, qty: 1 }] });
    expect(sale.status).toBe(201);
    expect((await Shift.findOne({ _id: t.shiftId, shopId: t.shop.shopId }).lean())!.status).toBe('open');
    expect(await Shift.countDocuments({ shopId: t.shop.shopId })).toBe(1);
  });
});

describe('scanned codes', () => {
  it('finds the GTIN inside a GS1 marking code and keeps the full code', () => {
    const dm = '0104780000000013215abcde\u001d93XYZ1';
    expect(codeCandidates(dm)).toEqual({ codes: [dm, '04780000000013', '4780000000013'], markingCode: dm });
    expect(codeCandidates(']d2' + dm).markingCode).toBe(dm);
    expect(codeCandidates('4780000000013')).toEqual({ codes: ['4780000000013'], markingCode: undefined });
    expect(codeCandidates('012345678905').codes).toContain('0012345678905');
  });
});
