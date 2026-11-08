import { Shop } from '../src/models/core';
import { P, api, bearer, createShop, login, superSession } from './helpers';

let n = 0;
export const uniq = () => ++n;

/** A freshly created shop with its admin, plus request helpers bound to it. */
export async function setup(shopOverrides: Record<string, unknown> = {}, existingSuper?: { token: string }) {
  const sa = existingSuper ?? (await superSession());
  const shop = await createShop(sa.token, shopOverrides);
  const A = bearer(shop.admin.token);
  const post = (path: string, body: object, h = A) => api().post(`${P}${path}`).set(h).send(body);
  const patch = (path: string, body: object, h = A) => api().patch(`${P}${path}`).set(h).send(body);
  const get = (path: string, h = A) => api().get(`${P}${path}`).set(h);
  const put = (path: string, body: object, h = A) => api().put(`${P}${path}`).set(h).send(body);

  async function staff(role: string, extra: Record<string, unknown> = {}) {
    const k = uniq();
    const body = { role, fullName: `Staff ${k}`, login: `staff${k}x`, password: 'password123', branchIds: [shop.branchId], ...extra };
    const r = await post('/users', body);
    if (r.status !== 201) throw new Error(`staff create ${r.status} ${JSON.stringify(r.body)}`);
    const s = await login(body.login, 'password123');
    return { id: r.body.data.id as string, h: bearer(s.token), login: body.login };
  }
  async function product(extra: Record<string, unknown> = {}) {
    const k = uniq();
    const r = await post('/products', { name: `Product ${k}`, barcodes: [`46000000${String(k).padStart(5, '0')}`], ...extra });
    if (r.status !== 201) throw new Error(`product create ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data as { id: string; barcodes: string[]; name: string };
  }
  async function branch(name: string, extra: Record<string, unknown> = {}) {
    await Shop.updateOne({ _id: shop.shopId }, { 'limits.maxBranches': 20 });
    const r = await post('/branches', { name, ...extra });
    if (r.status !== 201) throw new Error(`branch create ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.id as string;
  }
  async function supplier(extra: Record<string, unknown> = {}) {
    const r = await post('/suppliers', { name: `Supplier ${uniq()}`, paymentTermDays: 7, ...extra });
    if (r.status !== 201) throw new Error(`supplier create ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data as { id: string };
  }
  /** Posts a goods receipt: [productId, qty, costMinor] lines. */
  async function receive(branchId: string, supplierId: string, lines: Array<[string, number, number]>) {
    const r = await post('/goods-receipts', { supplierId, branchId, post: true, lines: lines.map(([productId, qty, cost]) => ({ productId, qty, cost })) });
    if (r.status !== 201) throw new Error(`receive ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  }
  async function stockOf(productId: string, branchId = shop.branchId) {
    const { Stock } = await import('../src/models/stock');
    const s = await Stock.findOne({ shopId: shop.shopId, branchId, productId }).lean();
    return { quantity: s?.quantity ?? 0, avgCost: s?.avgCost ?? 0 };
  }
  return { sa, shop, A, post, patch, get, put, staff, product, branch, supplier, receive, stockOf };
}
