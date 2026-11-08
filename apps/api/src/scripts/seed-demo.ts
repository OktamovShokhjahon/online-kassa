/**
 * Full demo data set. Everything is created through the public HTTP API (so it doubles as a usage example),
 * and then moved back in time with direct database updates so that dashboards and reports have a month of history:
 *
 *  - "Demo Market": 2 branches, 3 terminals, 6 staff, a category tree, ~45 products with prices per branch,
 *    suppliers, goods receipts, a transfer with a discrepancy, a write-off, a stock count, promotions of every type,
 *    loyalty customers (bonus, credit, debt), ~30 days of sales/refunds/cash operations/shifts, an API key, a webhook,
 *    an open shift with today's sales on one terminal.
 *  - "Chaikhona Fiscal": a fiscal shop (mock fiscal module) with a few days of fiscalized sales.
 *  - extra shops in other states for the superadmin panel: trial, expired, blocked.
 *
 * Runs inside the dev stack process (it needs the models for time travel). Idempotent: skipped when the demo shop exists.
 */
import { applyPromotions, ean13CheckDigit, type PromotionDef } from '@kass/shared';
import mongoose from 'mongoose';

type Json = any;
const TZ_MS = 5 * 3600_000; // Asia/Tashkent
const DAY = 86_400_000;
const WEBHOOK_URL = process.env.DEMO_WEBHOOK_URL ?? 'http://localhost:4010/webhook';

/* ------------------------------------------------------------------------------ helpers */

function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rngFrom(20261107);
const rint = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
const uzs = (n: number) => n * 100; // whole so'm -> minor units

/** UTC ms of local (Tashkent) midnight, `daysAgo` days back. */
const dayStart = (daysAgo: number) => Math.floor((Date.now() + TZ_MS) / DAY) * DAY - TZ_MS - daysAgo * DAY;
const weekday = (daysAgo: number) => new Date(dayStart(daysAgo) + TZ_MS).getUTCDay(); // 0 = Sunday

class Api {
  token = '';
  user: Json;
  constructor(private base: string, readonly login: string, private password: string) {}
  async signIn() {
    const r = await this.raw('POST', '/auth/login', { login: this.login, password: this.password }, false);
    this.token = r.accessToken;
    this.user = r.user;
    return this;
  }
  private async raw(method: string, path: string, body?: unknown, auth = true): Promise<Json> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: Json = await res.json().catch(() => ({}));
    if (res.status === 401 && auth) {
      await this.signIn();
      return this.raw(method, path, body, true);
    }
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${json?.error?.code ?? ''} ${JSON.stringify(json?.error?.details ?? '')}`), { code: json?.error?.code, status: res.status });
    return 'data' in json ? json.data : json;
  }
  get = (p: string) => this.raw('GET', p);
  post = (p: string, b: unknown = {}) => this.raw('POST', p, b);
  put = (p: string, b: unknown) => this.raw('PUT', p, b);
  patch = (p: string, b: unknown) => this.raw('PATCH', p, b);
}

/* ------------------------------------------------------------------------- time travel */

/**
 * Moves everything created since `t0` back so that "now" becomes `to` (ms epoch): every date inside the touched
 * documents that is >= t0 shifts by the same distance. Used right after each API call that records history.
 */
async function travel(models: Json[], t0: Date, to: number) {
  const delta = Date.now() - to;
  if (delta <= 0) return;
  for (const M of models) {
    const fields: string[] = [];
    M.schema.eachPath((p: string, t: Json) => { if (t.instance === 'Date') fields.push(p); });
    const set: Record<string, unknown> = {};
    for (const f of fields) set[f] = { $cond: [{ $and: [{ $eq: [{ $type: `$${f}` }, 'date'] }, { $gte: [`$${f}`, t0] }] }, { $subtract: [`$${f}`, delta] }, `$${f}`] };
    await M.collection.updateMany({ createdAt: { $gte: t0 } }, [{ $set: set }]);
  }
}

/* ----------------------------------------------------------------------------- catalog */

interface Item { name: string; cat: string; price: number; cost: number; unit?: 'piece' | 'kg'; marked?: boolean; hot?: number }
const CATEGORIES: Array<[string, string | null]> = [
  ['Drinks', null], ['Soft drinks', 'Drinks'], ['Water', 'Drinks'], ['Juices', 'Drinks'], ['Tea & coffee', 'Drinks'],
  ['Dairy', null], ['Bakery', null], ['Grocery', null], ['Sweets', null], ['Fruit & vegetables', null], ['Household', null],
];
const ITEMS: Item[] = [
  { name: 'Coca-Cola 1.5L', cat: 'Soft drinks', price: 12000, cost: 8200, hot: 4 },
  { name: 'Pepsi 1.5L', cat: 'Soft drinks', price: 11500, cost: 7800, hot: 3 },
  { name: 'Fanta 1L', cat: 'Soft drinks', price: 9500, cost: 6400 },
  { name: 'Sprite 1L', cat: 'Soft drinks', price: 9500, cost: 6400 },
  { name: 'Red Bull 0.25L', cat: 'Soft drinks', price: 18000, cost: 12500 },
  { name: 'Hydrolife water 1.5L', cat: 'Water', price: 4500, cost: 2600, hot: 5 },
  { name: 'Bon Aqua water 0.5L', cat: 'Water', price: 3000, cost: 1700, hot: 3 },
  { name: 'Nestle Pure Life 5L', cat: 'Water', price: 9000, cost: 5600 },
  { name: 'Nectar apple juice 1L', cat: 'Juices', price: 14000, cost: 9800 },
  { name: 'Rich orange juice 1L', cat: 'Juices', price: 16000, cost: 11200 },
  { name: 'Ahmad Tea Earl Grey 100 bags', cat: 'Tea & coffee', price: 38000, cost: 27500 },
  { name: 'Nescafe Gold 95g', cat: 'Tea & coffee', price: 62000, cost: 46000 },
  { name: 'Lipton Yellow Label 25 bags', cat: 'Tea & coffee', price: 14000, cost: 9900 },
  { name: 'Milk Lactel 1L', cat: 'Dairy', price: 13000, cost: 9600, hot: 4 },
  { name: 'Kefir Nestle 0.9L', cat: 'Dairy', price: 11000, cost: 7900, hot: 2 },
  { name: 'Sour cream 20% 400g', cat: 'Dairy', price: 16000, cost: 11800 },
  { name: 'Gouda cheese (kg)', cat: 'Dairy', price: 95000, cost: 72000, unit: 'kg' },
  { name: 'Butter 82% 180g', cat: 'Dairy', price: 22000, cost: 16500 },
  { name: 'Danone yoghurt 125g', cat: 'Dairy', price: 5000, cost: 3300, hot: 2 },
  { name: 'Eggs C1 (10 pcs)', cat: 'Dairy', price: 17000, cost: 13200, hot: 3 },
  { name: 'Non (flat bread)', cat: 'Bakery', price: 4000, cost: 2300, hot: 6 },
  { name: 'Baguette', cat: 'Bakery', price: 6000, cost: 3500, hot: 2 },
  { name: 'Lavash', cat: 'Bakery', price: 3500, cost: 2000, hot: 2 },
  { name: 'Rice Lazer (kg)', cat: 'Grocery', price: 22000, cost: 16000, unit: 'kg', hot: 2 },
  { name: 'Buckwheat 800g', cat: 'Grocery', price: 18000, cost: 13000 },
  { name: 'Pasta Makfa 400g', cat: 'Grocery', price: 9000, cost: 6400 },
  { name: 'Flour 2kg', cat: 'Grocery', price: 14000, cost: 10200 },
  { name: 'Sugar 1kg', cat: 'Grocery', price: 13000, cost: 10100, hot: 3 },
  { name: 'Salt 1kg', cat: 'Grocery', price: 3000, cost: 1700 },
  { name: 'Sunflower oil 1L', cat: 'Grocery', price: 17000, cost: 13100, hot: 2 },
  { name: 'Alpen Gold chocolate 90g', cat: 'Sweets', price: 12000, cost: 8400 },
  { name: 'Snickers 50g', cat: 'Sweets', price: 8000, cost: 5600, hot: 3 },
  { name: 'Oreo cookies 95g', cat: 'Sweets', price: 9500, cost: 6700 },
  { name: 'Halva 400g', cat: 'Sweets', price: 28000, cost: 20500 },
  { name: 'Apples (kg)', cat: 'Fruit & vegetables', price: 18000, cost: 11000, unit: 'kg', hot: 2 },
  { name: 'Bananas (kg)', cat: 'Fruit & vegetables', price: 22000, cost: 15000, unit: 'kg' },
  { name: 'Tomatoes (kg)', cat: 'Fruit & vegetables', price: 15000, cost: 9000, unit: 'kg', hot: 2 },
  { name: 'Potatoes (kg)', cat: 'Fruit & vegetables', price: 8000, cost: 4800, unit: 'kg', hot: 2 },
  { name: 'Onions (kg)', cat: 'Fruit & vegetables', price: 6000, cost: 3400, unit: 'kg' },
  { name: 'Fairy dish soap 450ml', cat: 'Household', price: 21000, cost: 15200 },
  { name: 'Ariel washing powder 3kg', cat: 'Household', price: 85000, cost: 64000 },
  { name: 'Toilet paper 4 rolls', cat: 'Household', price: 18000, cost: 12600 },
  { name: 'Paper napkins 100 pcs', cat: 'Household', price: 6000, cost: 3800 },
  { name: 'Trash bags 30 pcs', cat: 'Household', price: 9000, cost: 6000 },
  { name: 'Sarbast Lager beer 0.5L (marked)', cat: 'Soft drinks', price: 12000, cost: 8500, marked: true },
];
const SUPPLIERS = [
  { name: 'Global Trade LLC', phone: '+998 71 200 00 00', paymentTermDays: 14, cats: ['Soft drinks', 'Water', 'Juices', 'Sweets'] },
  { name: 'Agro Fresh', phone: '+998 71 233 44 55', paymentTermDays: 3, cats: ['Dairy', 'Bakery', 'Fruit & vegetables'] },
  { name: 'Tashkent Wholesale', phone: '+998 71 244 12 12', paymentTermDays: 30, cats: ['Tea & coffee', 'Grocery', 'Household'] },
];
const CUSTOMERS = [
  ['Aziz Karimov', 120000], ['Dilfuza Rakhimova', 80000], ['Bobur Tursunov', 0], ['Malika Yusupova', 50000], ['Sherzod Abdullayev', 200000],
  ['Nodira Saidova', 0], ['Jahongir Ismoilov', 0], ['Zilola Nazarova', 100000], ['Ulugbek Mirzaev', 0], ['Gulnora Hasanova', 0],
  ['Rustam Qodirov', 150000], ['Feruza Alimova', 0], ['Otabek Nurmatov', 0], ['Sevara Ergasheva', 0],
] as Array<[string, number]>;

/* --------------------------------------------------------------------------------- run */

interface Till { id: string; name: string; branchId: string; cashier: Api; weight: number }
interface Shop {
  admin: Api;
  shopId: string;
  products: Array<{ id: string; item: Item; catIds: string[]; barcode: string; weight: number }>;
  priceOf: (branchId: string, productId: string) => number;
  customers: Json[];
  promotions: () => Promise<PromotionDef[]>;
}

export async function seedDemo(base: string) {
  const started = Date.now();
  const { loadPromotionDefs } = await import('../modules/pos/saleService');
  const M = await import('../models');
  const SALE_MODELS = [M.Sale, M.StockMovement, M.BonusTransaction, M.AuditLog];
  const sa = await new Api(base, process.env.SUPERADMIN_LOGIN ?? 'admin', process.env.SUPERADMIN_PASSWORD ?? 'a@a@admina@a@').signIn();

  if ((await sa.get('/admin/shops?q=demo.admin')).length) return console.log('Demo shop already exists (demo.admin / demo12345)');
  console.log('Creating the demo data set (about a minute)…');
  const stats = { sales: 0, refunds: 0, failed: 0, shifts: 0 };

  /* ---------------------------------------------------------------- shop 1: Demo Market */
  await sa.post('/admin/shops', {
    name: 'Demo Market', adminFullName: 'Demo Owner', adminPhone: '+998 90 123 45 67', adminLogin: 'demo.admin', adminPassword: 'demo12345',
    firstBranchName: 'Chilonzor', address: 'Toshkent, Chilonzor 7', currency: 'UZS', tin: '305987654',
    paidUntil: new Date(Date.now() + 25 * DAY).toISOString(), limits: { maxBranches: 5, maxTerminals: 10, maxEmployees: 30 }, note: 'Demo shop with a month of history',
  });
  const admin = await new Api(base, 'demo.admin', 'demo12345').signIn();
  const shopId = admin.user.shopId as string;
  const b1 = (await admin.get('/branches'))[0].id as string;
  const b2 = (await admin.post('/branches', { name: 'Yunusobod', address: 'Toshkent, Yunusobod 4', phone: '+998 71 255 00 11' })).id as string;
  await admin.patch('/settings', { maxCashierDiscount: 5, receiptFooter: 'Rahmat! Thank you! Спасибо!', receiptHeader: 'Demo Market', loyalty: { bonusPercent: 2, maxPayPercent: 50 }, openShiftAlertHours: 14 });

  const t1 = await admin.post('/terminals', { name: 'Kassa 1', branchId: b1 });
  const t2 = await admin.post('/terminals', { name: 'Kassa 2', branchId: b1 });
  const t3 = await admin.post('/terminals', { name: 'Kassa 1 (Yunusobod)', branchId: b2 });

  await admin.post('/users', { role: 'branch_manager', fullName: 'Demo Manager', login: 'demo.manager', password: 'demo12345', branchIds: [b1, b2], pin: '9999', phone: '+998 90 111 22 33' });
  await admin.post('/users', { role: 'storekeeper', fullName: 'Demo Storekeeper', login: 'demo.store', password: 'demo12345', branchIds: [b1, b2] });
  await admin.post('/users', { role: 'cashier', fullName: 'Demo Cashier', login: 'demo.cashier', password: 'demo12345', branchIds: [b1], pin: '1234', permissions: ['sales.refund', 'customers.create'] });
  await admin.post('/users', { role: 'cashier', fullName: 'Dilnoza Karimova', login: 'dilnoza', password: 'demo12345', branchIds: [b1], pin: '2222', permissions: ['sales.refund', 'sales.credit', 'customers.create'] });
  await admin.post('/users', { role: 'cashier', fullName: 'Jasur Aliyev', login: 'jasur', password: 'demo12345', branchIds: [b2], pin: '3333', permissions: ['sales.refund'] });
  const manager = await new Api(base, 'demo.manager', 'demo12345').signIn();
  const store = await new Api(base, 'demo.store', 'demo12345').signIn();
  const cash1 = await new Api(base, 'demo.cashier', 'demo12345').signIn();
  const cash2 = await new Api(base, 'dilnoza', 'demo12345').signIn();
  const cash3 = await new Api(base, 'jasur', 'demo12345').signIn();
  const tills: Till[] = [
    { id: t1.id, name: 'Kassa 1', branchId: b1, cashier: cash1, weight: 1 },
    { id: t2.id, name: 'Kassa 2', branchId: b1, cashier: cash2, weight: 0.7 },
    { id: t3.id, name: 'Kassa 1 (Yunusobod)', branchId: b2, cashier: cash3, weight: 0.8 },
  ];

  // catalog
  const catId = new Map<string, string>();
  const catChain = new Map<string, string[]>();
  for (const [name, parent] of CATEGORIES) {
    const c = await admin.post('/categories', { name, parentId: parent ? catId.get(parent) : null });
    catId.set(name, c.id);
    catChain.set(c.id, parent ? [c.id, catId.get(parent)!] : [c.id]);
  }
  const priceB2 = (p: number) => Math.round(p * 1.05);
  const products: Shop['products'] = [];
  let seq = 0;
  for (const item of ITEMS) {
    const first12 = `478${String(100000000 + ++seq * 7919).slice(0, 9)}`;
    const barcode = first12 + ean13CheckDigit(first12);
    const p = await admin.post('/products', {
      name: item.name, barcodes: [barcode], categoryId: catId.get(item.cat), unit: item.unit ?? 'piece', isWeighted: item.unit === 'kg', vatRate: 12,
      ...(item.marked ? { isMarked: true, mxikCode: '02203001001000000', packageCode: '1500393' } : {}),
      prices: [{ branchId: b1, price: uzs(item.price) }, { branchId: b2, price: priceB2(uzs(item.price)) }],
    });
    products.push({ id: p.id, item, catIds: catChain.get(catId.get(item.cat)!)!, barcode, weight: (item.hot ?? 1) * (0.5 + rand()) });
  }
  const prodByName = (n: string) => products.find((p) => p.item.name.startsWith(n))!;

  // suppliers
  const suppliers: Array<{ id: string; cats: string[] }> = [];
  for (const s of SUPPLIERS) suppliers.push({ id: (await admin.post('/suppliers', { name: s.name, phone: s.phone, paymentTermDays: s.paymentTermDays, contactPerson: 'Sales manager' })).id, cats: s.cats });
  const supplierFor = (p: Shop['products'][number]) => suppliers.find((s) => s.cats.includes(p.item.cat))!;
  const receive = async (api: Api, branchId: string, qtyOf: (p: Shop['products'][number]) => number) => {
    for (const s of suppliers) {
      const lines = products.filter((p) => supplierFor(p) === s).map((p) => ({ productId: p.id, qty: qtyOf(p), cost: uzs(p.item.cost) })).filter((l) => l.qty > 0);
      if (lines.length) await api.post('/goods-receipts', { supplierId: s.id, branchId, post: true, invoiceNo: `INV-${rint(1000, 9999)}`, lines });
    }
  };

  // promotions
  const water = catId.get('Water')!;
  await admin.post('/promotions', { name: 'Water -10%', type: 'percent', rules: { percent: 10, categoryIds: [water] } });
  await admin.post('/promotions', { name: 'Snickers: buy 2, get 1 free', type: 'buy_x_get_y', rules: { buyQty: 2, getQty: 1, productIds: [prodByName('Snickers').id] } });
  await admin.post('/promotions', { name: 'Breakfast set', type: 'bundle', rules: { items: [{ productId: prodByName('Milk').id, qty: 1 }, { productId: prodByName('Non').id, qty: 1 }, { productId: prodByName('Eggs').id, qty: 1 }], bundlePrice: uzs(33000) } });
  await admin.post('/promotions', { name: 'Rice: 2 000 off per kg', type: 'fixed', rules: { amount: uzs(2000), productIds: [prodByName('Rice').id] } });
  await admin.post('/promotions', { name: 'Happy hour: bakery -15%', type: 'percent', schedule: { from: '19:00', to: '21:00' }, rules: { percent: 15, categoryIds: [catId.get('Bakery')!] } });
  await admin.post('/promotions', { name: 'New Year (ended)', type: 'percent', isActive: false, startsAt: '2025-12-20', endsAt: '2026-01-10', rules: { percent: 20, categoryIds: [catId.get('Sweets')!] } });
  const promotions = () => loadPromotionDefs(new mongoose.Types.ObjectId(shopId));

  // customers
  const customers: Json[] = [];
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const [fullName, credit] = CUSTOMERS[i];
    customers.push(await admin.post('/customers', {
      fullName, phone: `+998 9${rint(0, 9)} ${rint(100, 999)} ${rint(10, 99)} ${rint(10, 99)}`, cardBarcode: `LOY-${String(i + 1).padStart(4, '0')}`,
      birthday: `199${rint(0, 9)}-${String(rint(1, 12)).padStart(2, '0')}-${String(rint(1, 28)).padStart(2, '0')}`,
      ...(credit ? { creditLimit: uzs(credit) } : {}),
    }));
  }

  // min stock (low-stock alerts)
  for (const branchId of [b1, b2]) await admin.put('/stock/min-stock', { branchId, items: products.map((p) => ({ productId: p.id, minStock: p.item.unit === 'kg' ? 10 : 12 })) });

  const shop1: Shop = {
    admin, shopId, products,
    priceOf: (branchId, productId) => { const p = products.find((x) => x.id === productId)!; return branchId === b1 ? uzs(p.item.price) : priceB2(uzs(p.item.price)); },
    customers, promotions,
  };

  /* -------------------------------------------------- history engine (shared by both shops) */
  async function sell(shop: Shop, till: Till, shiftId: string, when: number, opts: { cart?: Array<{ p: Shop['products'][number]; qty: number }>; method?: 'cash' | 'card' | 'credit' | 'bonus'; customer?: Json; discount?: boolean; approval?: boolean } = {}) {
    const cart = opts.cart ?? [];
    if (!opts.cart) {
      const n = rint(1, 6);
      const pool = [...shop.products.filter((p) => !p.item.marked)];
      while (cart.length < n && pool.length) {
        const total = pool.reduce((s, p) => s + p.weight, 0);
        let r = rand() * total;
        const idx = pool.findIndex((p) => (r -= p.weight) <= 0);
        const [p] = pool.splice(idx < 0 ? 0 : idx, 1);
        cart.push({ p, qty: p.item.unit === 'kg' ? Math.round((0.3 + rand() * 2.2) * 10) / 10 : pick([1, 1, 1, 1, 2, 2, 3]) });
      }
    }
    const lines = cart.map(({ p, qty }) => ({ productId: p.id, qty, price: shop.priceOf(till.branchId, p.id) }));
    const promoLines = lines.map((l, i) => ({ key: String(i), productId: l.productId, categoryIds: shop.products.find((p) => p.id === l.productId)!.catIds, qty: l.qty, price: l.price }));
    const applied = applyPromotions(promoLines, await shop.promotions(), till.branchId, new Date());
    const promoDiscount = applied.reduce((s, a) => s + a.discount, 0);
    const gross = lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0);
    let manual = 0;
    const body: Json = { clientRequestId: crypto.randomUUID(), terminalId: till.id, shiftId, lines: lines.map(({ productId, qty }) => ({ productId, qty })), payments: [] };
    if (opts.discount && !applied.some((a) => a.key === '0')) { manual = Math.round((Math.round(lines[0].qty * lines[0].price) * (opts.approval ? 12 : 3)) / 100 / 100) * 100; body.lines[0].discount = manual; if (opts.approval) body.approval = { login: 'demo.manager', pin: '9999' }; }
    const total = gross - promoDiscount - manual;
    const method = opts.method ?? (rand() < 0.62 ? 'cash' : 'card');
    if (opts.customer) body.customerId = opts.customer.id;
    if (method === 'cash') body.payments = [{ method: 'cash', amount: Math.max(total, Math.ceil(gross / uzs(1000)) * uzs(1000)) }];
    else if (method === 'card') body.payments = [{ method: 'card', amount: total }];
    else if (method === 'credit') { const cashPart = Math.round(total * 0.2 / 100) * 100; body.payments = [{ method: 'credit', amount: total - cashPart }, ...(cashPart ? [{ method: 'cash', amount: cashPart }] : [])]; }
    else { const bonus = Math.min(opts.customer!.bonus ?? 0, Math.floor(total / 2)); body.payments = [{ method: 'bonus', amount: bonus }, { method: 'cash', amount: total - bonus }]; }
    const t0 = new Date();
    const sale = await till.cashier.post('/sales', body);
    if (when < Date.now() - 60_000) await travel(SALE_MODELS, t0, when);
    stats.sales++;
    return sale;
  }

  async function shiftDay(shop: Shop, till: Till, daysAgo: number, opts: { count: number; today?: boolean; customerRate?: number; creditOk?: boolean; extra?: (shiftId: string, times: number[]) => Promise<void> }) {
    const start = dayStart(daysAgo);
    const cashier = till.cashier;
    const t0 = new Date();
    const shift = await cashier.post('/shifts/open', { terminalId: till.id, openingCash: uzs(rint(2, 5) * 100_000) });
    stats.shifts++;
    if (!opts.today) await travel([M.AuditLog, M.Shift], t0, start + (8 * 60 + 45 + rint(0, 10)) * 60_000);
    const times = Array.from({ length: opts.count }, () => start + (9 * 60 + Math.floor(rand() * 12 * 60)) * 60_000).sort((a, b) => a - b);
    const made: Json[] = [];
    for (const when of times) {
      const useCustomer = rand() < (opts.customerRate ?? 0.3);
      const customer = useCustomer ? pick(shop.customers) : undefined;
      const roll = rand();
      try {
        const sale = await sell(shop, till, shift.id, opts.today ? Date.now() : when, {
          customer,
          method: customer && opts.creditOk && customer.creditLimit && roll < 0.2 ? 'credit' : undefined,
          discount: roll > 0.9, approval: roll > 0.97,
        });
        made.push(sale);
      } catch (e) {
        // e.g. over the customer's credit limit: the customer pays cash instead
        try { made.push(await sell(shop, till, shift.id, opts.today ? Date.now() : when, { method: 'cash' })); } catch (e2) {
          stats.failed++;
          if (stats.failed <= 3) console.warn('  sale skipped:', (e2 as Error).message, '|', (e as Error).message);
        }
      }
    }
    if (opts.today) return { shift, made };
    await opts.extra?.(shift.id, times);

    // lines the cashier removed before paying (staff activity report)
    if (made.length && rand() < 0.4) {
      const t = new Date();
      await cashier.post(`/shifts/${shift.id}/removed-lines`, { items: [{ name: pick(shop.products).item.name, qty: 1, price: uzs(rint(3, 30) * 1000), reason: pick(['line_removed', 'qty_decreased', 'cart_cleared']) }] });
      await travel([M.AuditLog], t, start + 12 * 3600_000);
    }
    // a payout in the middle of the day, sometimes a cash-in
    if (rand() < 0.5) {
      const t = new Date();
      await cashier.post('/cash-operations', { shiftId: shift.id, type: rand() < 0.7 ? 'out' : 'in', amount: uzs(rint(2, 20) * 5000), comment: pick(['Bread delivery', 'Courier payment', 'Change from the safe', 'Cleaning supplies']) });
      await travel([M.CashOperation, M.AuditLog], t, start + 13 * 3600_000);
    }
    // a refund now and then
    if (made.length && rand() < 0.22) {
      const sale = pick(made);
      const line = sale.lines[0];
      const t = new Date();
      try {
        await cashier.post('/refunds', { saleId: sale.id, lines: [{ productId: line.productId, lineIndex: 0, qty: Math.min(1, line.qty) }], reason: pick(['Customer changed mind', 'Expired product', 'Wrong item']), method: 'cash', restock: rand() < 0.7 ? 'stock' : 'writeoff', clientRequestId: crypto.randomUUID() });
        await travel([M.Refund, M.StockMovement, M.BonusTransaction, M.AuditLog, M.CashOperation], t, start + 16 * 3600_000);
        stats.refunds++;
      } catch { /* e.g. a fully credited receipt: skip */ }
    }
    // close: usually exact, sometimes a small difference
    const x = await cashier.get(`/shifts/${shift.id}/x-report`);
    const diff = rand() < 0.8 ? 0 : pick([-uzs(500), -uzs(1000), uzs(200), -uzs(2000)]);
    const tc = new Date();
    await cashier.post(`/shifts/${shift.id}/close`, { countedCash: x.totals.expectedCash + diff, unsentOfflineCount: 0, note: diff ? 'Counted twice' : undefined });
    const closeAt = start + (21 * 60 + 5 + rint(0, 20)) * 60_000;
    await travel([M.AuditLog], tc, closeAt);
    const openAt = new Date(start + (8 * 60 + 45 + rint(0, 10)) * 60_000);
    await M.Shift.collection.updateOne({ _id: new mongoose.Types.ObjectId(shift.id) }, { $set: { openedAt: openAt, createdAt: openAt, closedAt: new Date(closeAt), updatedAt: new Date(closeAt) } });
    return { shift, made };
  }

  /* -------------------------------------------------- the month, day by day (31 days ago -> yesterday) */
  const warehouse = async (d: number, fn: (when: number) => Promise<void>) => { await fn(dayStart(d) + 9 * 3600_000); };
  let counted = false;
  for (let d = 31; d >= 1; d--) {
    const dow = weekday(d);
    const busy = dow === 0 || dow === 6;
    // stock events
    if (d === 31) {
      const t = new Date();
      await receive(store, b1, (p) => (p.item.unit === 'kg' ? 120 : 160) - (p.item.name.startsWith('Hydrolife') ? 20 : 0));
      await receive(store, b2, (p) => (p.item.unit === 'kg' ? 70 : 90));
      await travel([M.GoodsReceipt, M.StockMovement, M.AuditLog], t, dayStart(31) + 10 * 3600_000);
    } else if (d % 7 === 3) {
      const t = new Date();
      await receive(store, b1, (p) => ((p.item.hot ?? 1) >= 3 ? 80 : 30));
      await receive(store, b2, (p) => ((p.item.hot ?? 1) >= 3 ? 50 : 15));
      await travel([M.GoodsReceipt, M.StockMovement, M.AuditLog], t, dayStart(d) + 10 * 3600_000);
    }
    if (d === 18) await warehouse(d, async (when) => {
      const t = new Date();
      const tr = await manager.post('/transfers', { fromBranchId: b1, toBranchId: b2, note: 'Weekly rebalancing', lines: [prodByName('Coca-Cola'), prodByName('Milk'), prodByName('Sugar'), prodByName('Hydrolife')].map((p) => ({ productId: p.id, qty: 20 })) });
      await manager.post(`/transfers/${tr.id}/send`, {});
      await travel([M.Transfer, M.StockMovement, M.AuditLog], t, when);
      const t2x = new Date();
      await manager.post(`/transfers/${tr.id}/receive`, { lines: [{ productId: prodByName('Milk').id, qtyReceived: 18 }], note: '2 packs damaged on the way' });
      await travel([M.Transfer, M.StockMovement, M.AuditLog], t2x, when + 4 * 3600_000);
    });
    if (d === 12) await warehouse(d, async (when) => {
      const t = new Date();
      await store.post('/write-offs', { branchId: b1, reason: 'expired', comment: 'Short shelf life', post: true, lines: [{ productId: prodByName('Kefir').id, qty: 6 }, { productId: prodByName('Danone').id, qty: 8 }] });
      await travel([M.WriteOff, M.StockMovement, M.AuditLog], t, when);
    });
    if (d === 8 && !counted) { counted = true; await warehouse(d, async (when) => {
      const t = new Date();
      const sc = await store.post('/stock-counts', { branchId: b1, categoryId: catId.get('Household') });
      const doc = await store.get(`/stock-counts/${sc.id}`);
      await store.put(`/stock-counts/${sc.id}/lines`, { lines: doc.lines.map((l: Json, i: number) => ({ productId: l.productId, counted: Math.max(0, Math.round(l.expected) - (i === 1 ? 2 : 0) + (i === 3 ? 1 : 0)) })) });
      await store.post(`/stock-counts/${sc.id}/post`, {});
      await travel([M.StockCount, M.StockMovement, M.AuditLog], t, when);
    }); }
    if (d === 20 || d === 6) await warehouse(d, async (when) => {
      const t = new Date();
      for (const s of suppliers.slice(0, 2)) await admin.post('/supplier-payments', { supplierId: s.id, amount: uzs(rint(30, 60) * 100_000), method: 'bank_transfer', paidAt: new Date(when).toISOString(), comment: 'Invoice payment' });
      await travel([M.SupplierPayment, M.AuditLog], t, when);
    });

    // trading
    for (const till of tills) {
      const base = busy ? rint(10, 15) : rint(7, 11);
      const count = Math.max(2, Math.round(base * till.weight * (d > 28 ? 0.7 : 1)));
      await shiftDay(shop1, till, d, {
        count, creditOk: till.cashier === cash2, customerRate: 0.3,
        extra: async (shiftId) => {
          // loyal customers repay part of their debt at the till of the cashier who sells on credit
          if (till.cashier === cash2 && d % 5 === 0) {
            const debtors = (await admin.get('/customers?debtOnly=true')) as Json[];
            if (debtors.length) {
              const c = pick(debtors);
              const t = new Date();
              try { await cash2.post('/customer-payments', { customerId: c.id, shiftId, amount: Math.min(c.debtBalance, uzs(20000)), method: 'cash' }); await travel([M.CustomerPayment, M.AuditLog], t, dayStart(d) + 15 * 3600_000); } catch { /* ignore */ }
            }
          }
        },
      });
    }
    if (d % 10 === 0) console.log(`  history: ${31 - d + 1}/31 days…`);
  }
  console.log(`  history: 31/31 days, ${stats.sales} sales, ${stats.refunds} refunds, ${stats.shifts} shifts`);

  // customers: last visit = their latest sale (the dates moved, the counters did not)
  for (const c of await M.Customer.collection.find({}).toArray()) {
    const last = await M.Sale.collection.find({ customerId: c._id }).sort({ createdAt: -1 }).limit(1).toArray();
    if (last[0]) await M.Customer.collection.updateOne({ _id: c._id }, { $set: { lastVisitAt: last[0].createdAt } });
  }
  // debts older than their repayments: debtSince = the oldest credit sale still counted
  for (const c of await M.Customer.collection.find({ debtBalance: { $gt: 0 } }).toArray()) {
    const first = await M.Sale.collection.find({ customerId: c._id, 'payments.method': 'credit' }).sort({ createdAt: 1 }).limit(1).toArray();
    if (first[0]) await M.Customer.collection.updateOne({ _id: c._id }, { $set: { debtSince: first[0].createdAt } });
  }

  // a few products run low in Chilonzor (the low-stock widgets and alerts have something to show)
  const rows = (await admin.get(`/stock?branchId=${b1}&limit=100`)) as Json[];
  const lowLines = ['Coca-Cola', 'Hydrolife', 'Eggs', 'Sugar', 'Milk'].flatMap((n) => {
    const p = prodByName(n);
    const row = rows.find((r) => String(r.productId) === p.id);
    const qty = row ? Math.floor(row.quantity) - rint(3, 8) : 0;
    return qty > 0 ? [{ productId: p.id, qty }] : [];
  });
  if (lowLines.length) await store.post('/write-offs', { branchId: b1, reason: 'lost', comment: 'Inventory shrinkage (demo: makes the low-stock widgets light up)', post: true, lines: lowLines });

  // a scheduled price change for tomorrow, an API key and a webhook
  await admin.post('/price-changes', { productId: prodByName('Coca-Cola').id, branchId: b1, newPrice: uzs(12500), effectiveAt: new Date(Date.now() + DAY).toISOString() });
  const key = await admin.post('/api-keys', { name: 'Accounting export', scopes: ['products:read', 'prices:read', 'stock:read', 'sales:read', 'reports:read'] });
  await admin.post('/webhooks', { url: WEBHOOK_URL, events: ['sale.created', 'sale.refunded', 'shift.closed', 'stock.low', 'goods_receipt.posted'], description: 'Demo receiver (npm run dev prints deliveries)' });

  // today: one terminal has an open shift with sales; Kassa 1 stays free so you can open your own shift
  const today = (await shiftDay(shop1, tills[1], 0, { count: 7, today: true, customerRate: 0.4, creditOk: true }))!;
  for (const c of (await admin.get('/customers?limit=50')) as Json[]) {
    if ((c.bonusBalance ?? 0) >= uzs(500)) {
      try { await sell(shop1, tills[1], today.shift.id, Date.now(), { customer: { ...c, bonus: c.bonusBalance }, method: 'bonus' }); } catch { /* bonus limit */ }
      break;
    }
  }

  // superadmin: payment history of the demo shop
  for (let m = 2; m >= 0; m--) {
    const from = new Date(Date.now() - (m + 1) * 30 * DAY), to = new Date(Date.now() - m * 30 * DAY);
    await sa.post(`/admin/shops/${shopId}/payments`, { amount: uzs(300_000), currency: 'UZS', periodFrom: from.toISOString(), periodTo: to.toISOString(), paidAt: from.toISOString(), method: m === 1 ? 'bank_transfer' : 'cash', comment: `Subscription month ${3 - m}` }).catch(() => undefined);
  }
  await sa.post(`/admin/shops/${shopId}/payments`, { amount: uzs(300_000), currency: 'UZS', periodFrom: new Date().toISOString(), periodTo: new Date(Date.now() + 25 * DAY).toISOString(), paidAt: new Date().toISOString(), method: 'card', comment: 'Current period' }).catch(() => undefined);

  /* ------------------------------------------------------- shop 2: fiscal shop with the mock module */
  await sa.post('/admin/shops', {
    name: 'Chaikhona Fiscal', adminFullName: 'Fiscal Owner', adminPhone: '+998 93 555 66 77', adminLogin: 'fiscal.admin', adminPassword: 'demo12345',
    firstBranchName: 'Main', address: 'Samarqand, Registon 1', currency: 'UZS', fiscalEnabled: true, tin: '301234567', adminLanguage: 'ru',
    paidUntil: new Date(Date.now() + 40 * DAY).toISOString(),
  });
  const fadmin = await new Api(base, 'fiscal.admin', 'demo12345').signIn();
  const fShopId = fadmin.user.shopId as string;
  const fb = (await fadmin.get('/branches'))[0].id as string;
  const ft = await fadmin.post('/terminals', { name: 'Fiscal till', branchId: fb });
  await sa.put(`/admin/shops/${fShopId}/terminals/${ft.id}/fiscal`, { provider: 'mock', moduleId: 'MOCK-0001', credentials: {} });
  await fadmin.post('/users', { role: 'cashier', fullName: 'Fiscal Cashier', login: 'fiscal.cashier', password: 'demo12345', branchIds: [fb], pin: '4444', permissions: [] });
  const fcash = await new Api(base, 'fiscal.cashier', 'demo12345').signIn();
  const fItems: Item[] = [
    { name: 'Plov (portion)', cat: 'Food', price: 35000, cost: 19000, hot: 5 }, { name: 'Shashlik (stick)', cat: 'Food', price: 22000, cost: 13000, hot: 4 },
    { name: 'Lagman', cat: 'Food', price: 30000, cost: 16000, hot: 3 }, { name: 'Green tea (pot)', cat: 'Drinks', price: 8000, cost: 2500, hot: 5 },
    { name: 'Compote 1L', cat: 'Drinks', price: 12000, cost: 5000 }, { name: 'Samarkand bread', cat: 'Bakery', price: 6000, cost: 3000, hot: 3 },
  ];
  const fprod: Shop['products'] = [];
  const fcat = new Map<string, string>();
  for (const name of ['Food', 'Drinks', 'Bakery']) fcat.set(name, (await fadmin.post('/categories', { name })).id);
  let fseq = 0;
  for (const item of fItems) {
    const first12 = `478${String(200000000 + ++fseq * 6007).slice(0, 9)}`;
    const barcode = first12 + ean13CheckDigit(first12);
    const p = await fadmin.post('/products', { name: item.name, barcodes: [barcode], categoryId: fcat.get(item.cat), unit: 'piece', vatRate: 12, mxikCode: `1020200100${String(fseq).padStart(7, '0')}`, packageCode: '1500393', prices: [{ branchId: fb, price: uzs(item.price) }] });
    fprod.push({ id: p.id, item, catIds: [fcat.get(item.cat)!], barcode, weight: (item.hot ?? 1) * (0.5 + rand()) });
  }
  const fsup = await fadmin.post('/suppliers', { name: 'Registon Market', paymentTermDays: 0 });
  await fadmin.post('/goods-receipts', { supplierId: fsup.id, branchId: fb, post: true, lines: fprod.map((p) => ({ productId: p.id, qty: 400, cost: uzs(p.item.cost) })) });
  const shop2: Shop = { admin: fadmin, shopId: fShopId, products: fprod, priceOf: (_b, id) => uzs(fprod.find((p) => p.id === id)!.item.price), customers: [], promotions: () => loadPromotionDefs(new mongoose.Types.ObjectId(fShopId)) };
  const fTill: Till = { id: ft.id, name: 'Fiscal till', branchId: fb, cashier: fcash, weight: 1 };
  for (let d = 6; d >= 1; d--) await shiftDay(shop2, fTill, d, { count: rint(6, 10), customerRate: 0 });

  /* ------------------------------------------------------------- shops in other states (superadmin) */
  await sa.post('/admin/shops', { name: 'Trial Cafe', adminFullName: 'Trial Owner', adminPhone: '+998 94 000 11 22', adminLogin: 'trial.admin', adminPassword: 'demo12345', currency: 'UZS', paidUntil: new Date(Date.now() + 5 * DAY).toISOString(), note: 'Trial ends soon' });
  await sa.post('/admin/shops', { name: 'Old Bakery', adminFullName: 'Bakery Owner', adminPhone: '+998 95 222 33 44', adminLogin: 'bakery.admin', adminPassword: 'demo12345', currency: 'UZS', paidUntil: new Date(Date.now() - 45 * DAY).toISOString(), note: 'Subscription expired' });
  const kiosk = await sa.post('/admin/shops', { name: 'Blocked Kiosk', adminFullName: 'Kiosk Owner', adminPhone: '+998 97 333 44 55', adminLogin: 'kiosk.admin', adminPassword: 'demo12345', currency: 'UZS', paidUntil: new Date(Date.now() + 15 * DAY).toISOString() });
  await sa.post(`/admin/shops/${kiosk.shop.id}/block`, { reason: 'Payment dispute (demo)' });

  console.log(`Demo ready in ${Math.round((Date.now() - started) / 1000)}s: ${stats.sales} sales, ${stats.refunds} refunds, ${stats.shifts} shifts, ${stats.failed} skipped.`);
  console.log(`API key for the public API (shown once): ${key.key}`);
}
