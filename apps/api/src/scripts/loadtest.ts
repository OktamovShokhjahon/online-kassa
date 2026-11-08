/**
 * Small dependency-free load test for the sale path.
 *
 *   npm run loadtest -w @kass/api -- --url http://localhost:4000 --login demo.cashier --password demo12345 --sales 300 --concurrency 10
 *
 * It opens a shift, sells the first priced product of the branch catalog `--sales` times with `--concurrency`
 * parallel requests (every request carries its own clientRequestId), closes the shift and prints throughput and
 * latency percentiles. Run it against a disposable environment: it creates real sales and stock movements.
 */
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const URL_ = arg('url', 'http://localhost:4000').replace(/\/$/, '');
const LOGIN = arg('login', 'demo.cashier');
const PASSWORD = arg('password', 'demo12345');
const SALES = Number(arg('sales', '200'));
const CONCURRENCY = Number(arg('concurrency', '10'));

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${URL_}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ''}`);
  return 'data' in json ? json.data : json;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const session = await call('POST', '/auth/login', undefined, { login: LOGIN, password: PASSWORD });
  const token: string = session.accessToken;
  const terminals = await call('GET', '/terminals', token);
  // a terminal that is free (or whose open shift is ours)
  let terminal: any;
  let shift: any;
  let opened = false;
  for (const t of terminals) {
    const cur = await call('GET', `/shifts/current?terminalId=${t.id}`, token);
    if (!cur) { terminal = t; opened = true; break; }
    if (cur.mine) { terminal = t; shift = cur; break; }
  }
  if (!terminal) throw new Error('every terminal has a shift of another cashier open');
  const catalog = await call('GET', `/pos/catalog?terminalId=${terminal.id}`, token);
  const priced = new Set(catalog.prices.map((p: any) => p.productId));
  const product = catalog.products.find((p: any) => priced.has(p.id) && p.isActive && !p.isWeighted && !p.isMarked);
  if (!product) throw new Error('no suitable priced product in the catalog');
  if (opened) shift = await call('POST', '/shifts/open', token, { terminalId: terminal.id, openingCash: 0 });

  const price = catalog.prices.find((p: any) => p.productId === product.id).price as number;
  const latencies: number[] = [];
  let failed = 0;
  let next = 0;
  const started = performance.now();
  const worker = async () => {
    while (next < SALES) {
      next++;
      const t0 = performance.now();
      try {
        await call('POST', '/sales', token, {
          clientRequestId: crypto.randomUUID(),
          terminalId: terminal.id,
          shiftId: shift.id,
          lines: [{ productId: product.id, qty: 1 }],
          payments: [{ method: 'cash', amount: price }],
        });
        latencies.push(performance.now() - t0);
      } catch (e) {
        failed++;
        if (failed <= 3) console.error((e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);

  if (opened) {
    const totals = await call('GET', `/shifts/${shift.id}/x-report`, token);
    await call('POST', `/shifts/${shift.id}/close`, token, { countedCash: totals.totals.expectedCash, unsentOfflineCount: 0 });
  }
  console.log(
    JSON.stringify(
      {
        product: product.name,
        sales: latencies.length,
        failed,
        concurrency: CONCURRENCY,
        seconds: Number(seconds.toFixed(2)),
        salesPerSecond: Number((latencies.length / seconds).toFixed(1)),
        latencyMs: { p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), p99: Math.round(pct(latencies, 99)), max: Math.round(latencies[latencies.length - 1] ?? 0) },
      },
      null,
      2,
    ),
  );
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
