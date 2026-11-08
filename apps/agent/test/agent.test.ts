import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { ConfigStore } from '../src/config';
import { Handlers } from '../src/handlers';
import { LocalServer, verifySessionKey } from '../src/localServer';
import { checkForUpdate, compareVersions, pair, PairingError } from '../src/pairing';
import type { ReceiptData } from '../src/render';
import { AesSecretStore } from '../src/secretStore';
import { ServerLink } from '../src/serverLink';
import { startSettingsUi } from '../src/settingsUi';

const SECRET = 'pairing-secret-xyz';
const TERMINAL = '64b0000000000000000000a1';
const sign = (terminalId = TERMINAL, exp = Date.now() + 3600_000, secret = SECRET) => `${exp}.${crypto.createHmac('sha256', secret).update(`${terminalId}.${exp}`).digest('base64url')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let out: string;
let config: ConfigStore;
let handlers: Handlers;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kass-agent-'));
  out = path.join(dir, 'printed.bin');
  config = new ConfigStore(dir, new AesSecretStore(dir));
  config.update({ terminal: { id: TERMINAL, name: 'Kassa 1', branchId: 'b1' }, allowedOrigins: ['http://localhost:3000'], printer: { transport: 'file', filePath: out, charsPerLine: 32, codePage: 'CP866', cutEnabled: true, drawerEnabled: true } });
  config.setCredentials('kat_token_value', SECRET);
  handlers = new Handlers(config, '1.0.0');
});

const receipt: ReceiptData = {
  type: 'sale', language: 'en', labels: { total: 'TOTAL', receipt: 'RECEIPT', cash: 'Cash' }, currency: 'UZS', shop: { name: 'Shop' }, branch: {}, number: '1-000001', createdAt: '06.11.2026 10:00:00',
  lines: [{ name: 'Cola', qty: 1, price: 1_200_000, discount: 0, total: 1_200_000 }], subtotal: 1_200_000, discount: 0, total: 1_200_000, payments: [{ method: 'cash', amount: 1_200_000 }],
};

describe('secrets at rest (spec 9.3)', () => {
  it('stores the device token and session secret encrypted, never in plain text', () => {
    const file = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    expect(file).not.toContain('kat_token_value');
    expect(file).not.toContain(SECRET);
    expect(config.token()).toBe('kat_token_value');
    expect(config.sessionSecret()).toBe(SECRET);
    expect(new ConfigStore(dir, new AesSecretStore(dir)).token()).toBe('kat_token_value'); // survives a restart
    config.clearCredentials();
    expect(config.isPaired()).toBe(false);
  });
});

describe('session keys', () => {
  it('verifies HMAC and expiry; rejects other terminals and tampering', () => {
    expect(verifySessionKey(SECRET, TERMINAL, sign())).toBe(true);
    expect(verifySessionKey(SECRET, TERMINAL, sign(TERMINAL, Date.now() - 1000))).toBe(false);
    expect(verifySessionKey(SECRET, '64b0000000000000000000a2', sign())).toBe(false);
    expect(verifySessionKey('other-secret', TERMINAL, sign())).toBe(false);
    const [exp, mac] = sign().split('.');
    expect(verifySessionKey(SECRET, TERMINAL, `${Number(exp) + 5000}.${mac}`)).toBe(false);
    expect(verifySessionKey(SECRET, TERMINAL, 'garbage')).toBe(false);
  });
});

describe('local socket for the POS (spec 9.4, 9.5)', () => {
  let server: LocalServer;
  let url: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    server = new LocalServer(config, handlers);
    url = `ws://127.0.0.1:${await server.start(0)}`;
  });
  afterEach(() => {
    sockets.splice(0).forEach((s) => s.terminate());
    server.stop();
  });

  const open = (origin?: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
      sockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  const call = (ws: WebSocket, type: string, payload?: unknown) =>
    new Promise<any>((resolve) => {
      const id = crypto.randomUUID();
      const on = (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.id === id) { ws.off('message', on); resolve(m); }
      };
      ws.on('message', on);
      ws.send(JSON.stringify({ type, id, payload }));
    });
  const authed = async () => {
    const ws = await open('http://localhost:3000');
    const r = await call(ws, 'hello', { sessionKey: sign(), terminalId: TERMINAL });
    expect(r.type).toBe('ack');
    return ws;
  };

  it('accepts only the platform web origin', async () => {
    await expect(open()).rejects.toThrow('403');
    await expect(open('https://evil.example')).rejects.toThrow('403');
    await expect(open('http://localhost:3000')).resolves.toBeTruthy();
  });

  it('requires a valid hello before anything else', async () => {
    const ws = await open('http://localhost:3000');
    const early = await call(ws, 'print.receipt', { receipt });
    expect(early).toMatchObject({ type: 'error', payload: { code: 'NOT_AUTHENTICATED' } });
    expect(fs.existsSync(out)).toBe(false);

    const bad = await call(ws, 'hello', { sessionKey: sign(TERMINAL, Date.now() + 1000, 'wrong'), terminalId: TERMINAL });
    expect(bad).toMatchObject({ type: 'error', payload: { code: 'AUTH_FAILED' } });
    const expired = await open('http://localhost:3000');
    expect((await call(expired, 'hello', { sessionKey: sign(TERMINAL, Date.now() - 5), terminalId: TERMINAL })).payload.code).toBe('AUTH_FAILED');
    const otherTerminal = await open('http://localhost:3000');
    expect((await call(otherTerminal, 'hello', { sessionKey: sign('64b0000000000000000000ff'), terminalId: '64b0000000000000000000ff' })).payload.code).toBe('AUTH_FAILED');
  });

  it('after hello: ack with the agent version, then a device status message', async () => {
    const ws = await open('http://localhost:3000');
    const statusMsg = new Promise<any>((r) => ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'status') r(m); }));
    const r = await call(ws, 'hello', { sessionKey: sign(), terminalId: TERMINAL });
    expect(r.payload).toMatchObject({ agentVersion: '1.0.0', terminal: { id: TERMINAL } });
    expect((await statusMsg).payload).toMatchObject({ printer: 'ok', scanner: 'none', drawer: 'enabled' });
  });

  it('prints a receipt from structured data (ESC/POS bytes, cut enabled)', async () => {
    const ws = await authed();
    const r = await call(ws, 'print.receipt', { receipt, copies: 2 });
    expect(r).toMatchObject({ type: 'ack', payload: { printed: true, copies: 2 } });
    const bytes = fs.readFileSync(out);
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(bytes.includes(Buffer.from('TOTAL'))).toBe(true);
    expect(bytes.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00]))).toBe(true);
    expect(bytes.includes(Buffer.from('*** COPY ***'))).toBe(true); // the 2nd printout is marked as a copy
  });

  it('opens the drawer only when enabled in the profile', async () => {
    const ws = await authed();
    expect((await call(ws, 'drawer.open')).type).toBe('ack');
    expect(fs.readFileSync(out).includes(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]))).toBe(true);
    config.update({ printer: { ...config.get().printer, drawerEnabled: false } });
    expect(await call(ws, 'drawer.open')).toMatchObject({ type: 'error', payload: { code: 'DRAWER_DISABLED' } });
  });

  it('prints reports, labels and the test page; rejects bad payloads and unknown commands', async () => {
    const ws = await authed();
    expect((await call(ws, 'print.test')).type).toBe('ack');
    expect((await call(ws, 'print.label', { name: 'Cola', price: 1_200_000, barcode: '4006381333931', quantity: 1 })).type).toBe('ack');
    expect((await call(ws, 'print.report', { report: { type: 'x_report', language: 'en', labels: {}, currency: 'UZS', shop: { name: 'S' }, branch: {}, openedAt: 'x', totals: { receipts: 0, gross: 0, discount: 0, net: 0, byMethod: { cash: 0, card: 0, bonus: 0, credit: 0 }, refunds: { count: 0, total: 0, cash: 0, card: 0, debt: 0 }, cashIn: 0, cashOut: 0, debtRepayments: { cash: 0, card: 0 }, openingCash: 0, expectedCash: 0 } } })).type).toBe('ack');
    expect((await call(ws, 'print.receipt', { receipt: { number: 'x' } })).payload.code).toBe('BAD_PAYLOAD');
    expect((await call(ws, 'format.disk')).payload.code).toBe('UNKNOWN_COMMAND');
  });

  it('reports printer problems to the POS so the cashier can retry', async () => {
    const ws = await authed();
    config.update({ printer: { ...config.get().printer, transport: 'network', host: undefined, filePath: undefined } });
    expect((await call(ws, 'print.test')).payload.code).toBe('PRINTER_NOT_CONFIGURED');
    handlers.transportFactory = () => ({ kind: 'x', send: async () => { throw new Error('Paper out'); } });
    expect(await call(ws, 'print.receipt', { receipt })).toMatchObject({ type: 'error', payload: { code: 'PRINT_ERROR', message: 'Paper out' } });
    expect(handlers.status().printer).toBe('error');
    handlers.transportFactory = () => ({ kind: 'x', send: async () => undefined });
    await call(ws, 'print.receipt', { receipt });
    expect(handlers.status().printer).toBe('ok');
  });

  it('forwards scanner input to authenticated POS pages only', async () => {
    const ws = await authed();
    const anon = await open('http://localhost:3000');
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    anon.on('message', (d) => got.push({ anon: JSON.parse(d.toString()) }));
    server.broadcast('scan', { barcode: '4006381333931', symbology: 'serial' });
    await sleep(100);
    expect(got.filter((m) => m.type === 'scan')).toEqual([expect.objectContaining({ payload: { barcode: '4006381333931', symbology: 'serial' } })]);
    expect(got.some((m) => m.anon)).toBe(false);
  });
});

describe('link to the platform (spec 9.4)', () => {
  let wss: WebSocketServer;
  let port: number;
  const received: any[] = [];
  let tokenSeen = '';
  let conn: WebSocket | undefined;
  beforeEach(async () => {
    received.length = 0;
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss.once('listening', r));
    port = (wss.address() as any).port;
    wss.on('connection', (ws, req) => {
      tokenSeen = new URL(req.url!, 'http://x').searchParams.get('token') ?? '';
      conn = ws;
      ws.on('message', (d) => received.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'hello', id: 'h', payload: {} }));
    });
    config.update({ wsUrl: `ws://127.0.0.1:${port}/agent/ws` });
  });
  afterEach(() => wss.close());

  it('connects with the device token, sends heartbeats and answers server commands', async () => {
    const link = new ServerLink(config, handlers, () => true);
    link.start();
    await sleep(250);
    expect(tokenSeen).toBe('kat_token_value');
    const hb = received.find((m) => m.type === 'heartbeat');
    expect(hb.payload).toMatchObject({ version: '1.0.0', devices: { printer: 'ok', scanner: 'ok' } });
    expect(link.online).toBe(true);

    conn!.send(JSON.stringify({ type: 'print.test', id: 'cmd-1', payload: {} }));
    await sleep(200);
    expect(received.find((m) => m.id === 'cmd-1')).toMatchObject({ type: 'ack', payload: { printed: true } });
    expect(fs.existsSync(out)).toBe(true);
    conn!.send(JSON.stringify({ type: 'format.disk', id: 'cmd-2', payload: {} }));
    await sleep(100);
    expect(received.find((m) => m.id === 'cmd-2')).toBeUndefined(); // unknown commands are ignored
    link.stop();
  });

  it('forgets its credentials when the server revokes the agent (close code 4001)', async () => {
    const link = new ServerLink(config, handlers);
    let revoked = false;
    link.onRevoked = () => (revoked = true);
    link.start();
    await sleep(250);
    conn!.close(4001, 'revoked');
    await sleep(250);
    expect(revoked).toBe(true);
    expect(config.token()).toBeNull();
    expect(config.isPaired()).toBe(false);
    link.stop();
  });
});

describe('pairing and updates (spec 9.3, 9.2)', () => {
  let api: http.Server;
  let base: string;
  let lastBody: any;
  beforeEach(async () => {
    api = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/agent/pair') {
          lastBody = JSON.parse(b);
          if (lastBody.code !== '123456') { res.statusCode = 422; return res.end(JSON.stringify({ error: { code: 'PAIRING_CODE_INVALID', message: 'bad code' } })); }
          return res.end(JSON.stringify({ data: { token: 'kat_new', sessionSecret: 's3cret', wsUrl: 'ws://srv/agent/ws', webOrigins: ['https://kass.example'], terminal: { id: 't9', name: 'Kassa 9', branchId: 'b9', printerProfile: { cutEnabled: true, charsPerLine: 32 } }, shop: { receiptLanguage: 'ru' } } }));
        }
        if (req.url === '/api/v1/agent/latest-version') return res.end(JSON.stringify({ data: { version: '1.2.0', url: 'https://dl/agent.exe' } }));
        res.statusCode = 404; res.end('{}');
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(api.address() as any).port}`;
  });
  afterEach(() => void api.close());

  it('exchanges the code for a token and stores the terminal settings', async () => {
    config.clearCredentials();
    const t = await pair(config, base, ' 123456 ', '1.0.0');
    expect(t).toMatchObject({ id: 't9', name: 'Kassa 9' });
    expect(lastBody).toMatchObject({ code: '123456', version: '1.0.0' });
    expect(lastBody.machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(config.token()).toBe('kat_new');
    expect(config.get()).toMatchObject({ wsUrl: 'ws://srv/agent/ws', allowedOrigins: ['https://kass.example'], language: 'ru', serverUrl: base });
    expect(config.get().printer.cutEnabled).toBe(true);
    await expect(pair(config, base, '000000', '1.0.0')).rejects.toMatchObject({ code: 'PAIRING_CODE_INVALID' });
    await expect(pair(config, 'http://127.0.0.1:1', '123456', '1.0.0')).rejects.toBeInstanceOf(PairingError);
  });

  it('detects a newer agent version', async () => {
    config.update({ serverUrl: base });
    expect(await checkForUpdate(config, '1.0.0')).toEqual({ available: true, version: '1.2.0', url: 'https://dl/agent.exe' });
    expect((await checkForUpdate(config, '1.2.0')).available).toBe(false);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
  });
});

describe('settings window', () => {
  it('serves the page on loopback only, protects changes, and runs a test print', async () => {
    const ui = await startSettingsUi(config, handlers, { onPaired() {}, onUnpair() {}, linkOnline: () => true, update: () => ({ available: false }) }, 0);
    const call = (p: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      fetch(`http://127.0.0.1:${ui.port}${p}`, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...opts.headers }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    expect((await (await call('/')).text())).toContain('<html');
    expect((await call('/api/state')).status).toBe(403); // no UI header
    expect((await call('/api/test-print', { method: 'POST', body: {} })).status).toBe(403);
    expect((await call('/', { headers: { Host: 'evil.example' } })).status).toBeGreaterThanOrEqual(200); // fetch ignores Host override; covered below
    const H = { 'X-Agent-UI': '1' };
    const state = await (await call('/api/state', { headers: H })).json();
    expect(state).toMatchObject({ version: '1.0.0', terminal: { name: 'Kassa 1' }, online: true });
    expect((await call('/api/printer', { method: 'POST', headers: H, body: { transport: 'file', cutEnabled: false, drawerEnabled: false } })).status).toBe(200);
    expect(config.get().printer.cutEnabled).toBe(false);
    expect((await call('/api/test-print', { method: 'POST', headers: H, body: {} })).status).toBe(200);
    expect(fs.readFileSync(out).length).toBeGreaterThan(50);
    expect((await call('/api/language', { method: 'POST', headers: H, body: { language: 'ru' } })).status).toBe(200);
    expect(config.get().language).toBe('ru');
    // rebinding defence: a request whose Host header is not loopback is refused
    const raw = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: ui.port, path: '/', headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
      r.end();
    });
    expect(raw).toBe(403);
    ui.close();
  });
});
