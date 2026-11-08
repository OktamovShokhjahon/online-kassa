#!/usr/bin/env node
/**
 * One command for everything:
 *
 *   npm run dev          backend (in-memory MongoDB replica set + API + workers), web, local printer agent,
 *                        webhook test receiver. Data survives restarts (.devdata/).
 *   npm run demo         the same, plus the full demo data set (a month of sales, staff, stock, promotions…).
 *                        Applied once; running it again just starts everything on the same data.
 *   npm run demo:reset   wipes .devdata first, then loads the demo again (stop other runs first).
 *
 * Flags: --demo  --reset  --no-agent  --no-web  --verbose (show every API request log)
 * Ports: web 3000, API 4000, MongoDB 27018, agent 17890 (POS socket) / 17891 (settings), webhook receiver 4010.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DEMO = args.has('--demo');
const VERBOSE = args.has('--verbose');
const DATA = path.join(ROOT, '.devdata');
const API = 'http://localhost:4000/api/v1';
const WEB = 'http://localhost:3000';
const AGENT_UI = 'http://127.0.0.1:17891';
const IS_WIN = process.platform === 'win32';

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const TAGS = { api: 36, web: 35, agent: 33, hook: 32, dev: 90 };
const tag = (t) => color(TAGS[t] ?? 37, `[${t.padEnd(5)}]`);
const log = (t, line) => console.log(`${tag(t)} ${line}`);

const children = [];
let shuttingDown = false;
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${tag('dev')} stopping…`);
  children.forEach(killTree);
  hookServer?.close();
  setTimeout(() => process.exit(code), 800).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Starts `npm <args>` in the repo root and prefixes its output. `onLine` sees every raw line. */
function run(name, npmArgs, { env = {}, filter, onLine } = {}) {
  const child = spawn(IS_WIN ? 'npm.cmd' : 'npm', npmArgs, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', ...env }, shell: IS_WIN, windowsHide: true });
  children.push(child);
  let buf = '';
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).replace(/\r$/, '').replace(/\u001b\[[0-9;]*m/g, ''); // drop colour codes
      buf = buf.slice(i + 1);
      if (!raw.trim()) continue;
      onLine?.(raw);
      const out = filter ? filter(raw) : raw;
      if (out) log(name, out);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      log('dev', color(31, `${name} exited with code ${code}`));
      if (name === 'api') shutdown(1); // nothing works without the backend
    }
  });
  return child;
}

/** API logs are JSON lines: show the interesting ones as plain text. */
function apiFilter(raw) {
  if (!raw.startsWith('{')) return raw;
  try {
    const j = JSON.parse(raw);
    if (VERBOSE) return `${j.level} ${j.msg} ${j.method ?? ''} ${j.path ?? ''} ${j.status ?? ''}`.trim();
    if (j.msg === 'request') return j.status >= 500 ? color(31, `${j.method} ${j.path} -> ${j.status}`) : null;
    if (j.level === 'error' || j.level === 'warn') return color(j.level === 'error' ? 31 : 33, `${j.msg} ${j.error ?? j.err ?? ''}`);
    return null;
  } catch {
    return raw;
  }
}

async function waitFor(url, label, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (shuttingDown) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log('dev', color(31, `${label} did not become ready in time`));
  return false;
}

/* --------------------------------------------------------------------- webhook test receiver */
let hookServer = null;
function startWebhookReceiver() {
  hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let event = '?';
      try { event = JSON.parse(body).event ?? '?'; } catch { /* not json */ }
      log('hook', `${req.method} ${req.url} event=${event} signature=${String(req.headers['x-kass-signature'] ?? '').slice(0, 20)}…`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  hookServer.on('error', (e) => log('hook', `receiver not started: ${e.code}`));
  hookServer.listen(4010, '127.0.0.1');
}

/* -------------------------------------------------------------------------- agent pairing */
async function jsonFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${body?.error?.code ?? body?.error ?? ''}`);
  return 'data' in body ? body.data : body;
}

/** Pairs the local agent with "Kassa 1" of the demo shop, printing to a text file instead of real hardware. */
async function pairAgent() {
  const ui = { 'x-agent-ui': '1' };
  try {
    if (!(await waitFor(`${AGENT_UI}/`, 'agent settings', 60_000))) return;
    const state = await jsonFetch(`${AGENT_UI}/api/state`, { headers: ui });
    if (state.terminal) return log('agent', `already paired with "${state.terminal.name}"`);
    const session = await jsonFetch(`${API}/auth/login`, { method: 'POST', body: JSON.stringify({ login: 'demo.admin', password: 'demo12345' }) }).catch(() => null);
    if (!session) return log('agent', 'not paired (no demo shop yet). Pair it in the shop panel under Terminals, then open ' + AGENT_UI);
    const auth = { authorization: `Bearer ${session.accessToken}` };
    const terminals = await jsonFetch(`${API}/terminals`, { headers: auth });
    const t = terminals.find((x) => x.name === 'Kassa 1') ?? terminals[0];
    if (!t) return;
    const { code } = await jsonFetch(`${API}/terminals/${t.id}/pairing-code`, { method: 'POST', headers: auth, body: '{}' });
    await jsonFetch(`${AGENT_UI}/api/pair`, { method: 'POST', headers: ui, body: JSON.stringify({ serverUrl: 'http://localhost:4000', code }) });
    const printed = path.join(DATA, 'printed');
    fs.mkdirSync(printed, { recursive: true });
    await jsonFetch(`${AGENT_UI}/api/printer`, { method: 'POST', headers: ui, body: JSON.stringify({ transport: 'file', filePath: path.join(printed, 'printer.bin'), cutEnabled: false, drawerEnabled: true }) });
    log('agent', `paired with "${t.name}"; printouts are written to ${path.join('.devdata', 'printed', 'receipts.txt')}`);
  } catch (e) {
    log('agent', color(33, `auto-pairing skipped: ${e.message}`));
  }
}

/* ------------------------------------------------------------------------------- banner */
const ACCOUNTS = [
  ['admin', 'a@a@admina@a@', 'Platform owner → /superadmin'],
  ['demo.admin', 'demo12345', 'Shop owner of Demo Market → /shop'],
  ['demo.manager', 'demo12345  (PIN 9999)', 'Branch manager → /shop'],
  ['demo.store', 'demo12345', 'Storekeeper → /shop'],
  ['demo.cashier', 'demo12345  (PIN 1234)', 'Cashier, Kassa 1, no shift yet → /pos  (agent is paired to this terminal)'],
  ['dilnoza', 'demo12345  (PIN 2222)', 'Cashier, Kassa 2, shift open, may sell on credit → /pos'],
  ['jasur', 'demo12345  (PIN 3333)', 'Cashier of the Yunusobod branch → /pos'],
  ['fiscal.admin', 'demo12345', 'Fiscal shop (mock fiscal module); fiscal.cashier / demo12345 → /pos'],
  ['trial.admin, bakery.admin, kiosk.admin', 'demo12345', 'Trial / expired / blocked shops (visible to root)'],
];
function banner(demoLoaded) {
  const w = Math.max(...ACCOUNTS.map((a) => a[0].length));
  const p = Math.max(...ACCOUNTS.map((a) => a[1].length));
  console.log('\n' + color(1, '  Online Kass is running'));
  console.log(`  Web      ${WEB}\n  API      ${API}   (docs: ${API}/docs)\n  Agent    ws://127.0.0.1:17890   settings ${AGENT_UI}\n  Printed  .devdata/printed/receipts.txt   Webhooks received: shown here as [hook]\n`);
  if (demoLoaded) {
    console.log('  Accounts');
    for (const [l, pw, d] of ACCOUNTS) console.log(`    ${l.padEnd(w)}  ${pw.padEnd(p)}  ${d}`);
  } else {
    console.log('  Platform owner: admin / a@a@admina@a@   (run "npm run demo" to load demo data)');
  }
  console.log(`\n  Ctrl+C stops everything.   Reset the data: stop, then "npm run demo:reset".\n`);
}

/* --------------------------------------------------------------------------------- main */
async function main() {
  if (args.has('--reset')) {
    fs.rmSync(DATA, { recursive: true, force: true });
    log('dev', 'removed .devdata');
  }
  fs.mkdirSync(path.join(DATA, 'agent'), { recursive: true });
  startWebhookReceiver();

  let demoState = 'none'; // none | loading | done
  if (DEMO) demoState = 'loading';
  const onApiLine = (raw) => {
    if (/Demo ready in|Demo shop already exists/.test(raw)) demoState = 'done';
    if (/Creating the demo data set/.test(raw)) log('dev', color(33, 'loading demo data… (about a minute on the first run)'));
  };
  run('api', ['run', 'dev:stack', ...(DEMO ? ['--', '--demo'] : [])], { filter: (l) => (l.startsWith('{') ? apiFilter(l) : l), onLine: onApiLine });

  if (!(await waitFor(`${API}/health`, 'API'))) return shutdown(1);
  log('dev', 'API is up');

  if (!args.has('--no-web')) run('web', ['run', 'dev:web'], { filter: (l) => (VERBOSE || /ready|local:|error|compiled|warn|fail/i.test(l) ? l.replace(/^[^\w]+/, '') : null) });
  if (!args.has('--no-agent')) {
    run('agent', ['run', 'dev:agent'], {
      env: { KASS_AGENT_DIR: path.join(DATA, 'agent'), KASS_AGENT_PREVIEW: path.join(DATA, 'printed', 'receipts.txt'), KASS_AGENT_NO_DPAPI: '1', KASS_AGENT_NO_OPEN: '1' },
    });
  }

  // wait for the demo data (the API is already usable while it loads)
  while (demoState === 'loading' && !shuttingDown) await new Promise((r) => setTimeout(r, 500));
  if (!args.has('--no-web')) await waitFor(`${WEB}/login`, 'web', 300_000);
  if (!args.has('--no-agent')) await pairAgent();
  const hasDemo = await jsonFetch(`${API}/auth/login`, { method: 'POST', body: JSON.stringify({ login: 'demo.admin', password: 'demo12345' }) }).then(() => true, () => false);
  if (!shuttingDown) banner(hasDemo);
}

main().catch((e) => {
  console.error(e);
  shutdown(1);
});
