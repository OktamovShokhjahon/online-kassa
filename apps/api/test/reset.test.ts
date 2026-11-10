/** Superadmin "Reset": wipes chosen data of one shop; the shop, its owner and first branch stay. */
import { describe, expect, it } from 'vitest';
import { RESET_GROUPS } from '@kass/shared';
import { Product } from '../src/models/catalog';
import { Shop } from '../src/models/core';
import { Sale } from '../src/models/sales';
import { Stock, Supplier } from '../src/models/stock';
import { P, api, bearer, createShop, login } from './helpers';
import { COLA, posCtx } from './posCtx';

const count = (preview: any[], g: string) => preview.find((x) => x.group === g);

describe('shop reset', () => {
  it('shows counts, refuses a wrong name, deletes chosen groups with what they need, keeps the rest', async () => {
    const t = await posCtx();
    const SA = bearer(t.sa.token);
    const R = `${P}/admin/shops/${t.shop.shopId}/reset`;
    expect((await t.sell([{ productId: t.cola.id, qty: 2 }], [{ method: 'cash', amount: 2 * COLA.price }])).status).toBe(201);
    const other = await createShop(t.sa.token);

    const pre = (await api().get(R).set(SA)).body.data;
    expect(pre.shopName).toBe(t.shop.payload.name);
    expect(count(pre.groups, 'sales').main).toBe(1);
    expect(count(pre.groups, 'products').main).toBe(2);
    expect(count(pre.groups, 'warehouse').total).toBeGreaterThan(0);
    expect(count(pre.groups, 'staff').main).toBeGreaterThan(0);

    // the shop name must be typed
    expect((await api().post(R).set(SA).send({ groups: ['sales'], confirmName: 'wrong' })).body.error.code).toBe('RESET_CONFIRM_MISMATCH');
    // shop users cannot reset
    expect((await api().post(R).set(t.A).send({ groups: ['sales'], confirmName: t.shop.payload.name })).status).toBe(403);

    // 1) sales only: stock goes back to what was received (the sale's movement is removed)
    const before = await t.stockOf(t.cola.id);
    let r = (await api().post(R).set(SA).send({ groups: ['sales'], confirmName: t.shop.payload.name.toUpperCase() })).body.data;
    expect(r.groups).toEqual(['sales']);
    expect(await Sale.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect((await t.stockOf(t.cola.id)).quantity).toBe(before.quantity + 2);
    expect(await Product.countDocuments({ shopId: t.shop.shopId })).toBe(2);
    // the open shift went with the sales: the till opens a new one, numbering starts again
    const sh = (await t.post('/shifts/open', { terminalId: t.term.id, openingCash: 0 }, t.cashier.h)).body.data;
    const again = await t.post('/sales', t.body([{ productId: t.cola.id, qty: 1 }], [{ method: 'cash', amount: COLA.price }], { shiftId: sh.id }), t.cashier.h);
    expect(again.status).toBe(201);
    expect(again.body.data.number).toMatch(/-0*1$/);

    // 2) products: the warehouse and promotions go with them, suppliers stay with a zero balance
    r = (await api().post(R).set(SA).send({ groups: ['products'], confirmName: t.shop.payload.name })).body.data;
    expect(r.groups).toEqual(['warehouse', 'products', 'promotions']);
    expect(await Product.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect(await Stock.countDocuments({ shopId: t.shop.shopId })).toBe(0);
    expect(await Supplier.countDocuments({ shopId: t.shop.shopId })).toBe(1);
    expect((await Supplier.findOne({ shopId: t.shop.shopId }).lean())!.balance).toBe(0);

    // 3) everything: owner, shop and first branch stay; the owner signs in to an empty shop
    r = (await api().post(R).set(SA).send({ groups: [...RESET_GROUPS], confirmName: t.shop.payload.name })).body.data;
    expect(r.groups).toEqual([...RESET_GROUPS]);
    const owner = await login(t.shop.payload.adminLogin, 'password123');
    const O = bearer(owner.token);
    expect((await api().get(`${P}/products`).set(O)).body.data).toEqual([]);
    expect((await api().get(`${P}/users`).set(O)).body.data.map((u: any) => u.role)).toEqual(['shop_admin']);
    expect((await api().get(`${P}/branches`).set(O)).body.data).toHaveLength(1);
    expect((await api().get(`${P}/terminals`).set(O)).body.data).toEqual([]);
    expect((await Shop.findById(t.shop.shopId).lean())!.currencyLocked).toBe(false);
    // the cashier's sign-in is gone
    expect((await api().post(`${P}/auth/login`).send({ login: t.cashier.login, password: 'password123' })).status).toBe(401);
    // the other shop is untouched
    expect((await api().get(`${P}/branches`).set(bearer(other.admin.token))).body.data).toHaveLength(1);
    const otherPre = (await api().get(`${P}/admin/shops/${other.shopId}/reset`).set(SA)).body.data;
    expect(count(otherPre.groups, 'audit').main).toBeGreaterThanOrEqual(0);
    // a new product can be created again right away
    expect((await api().post(`${P}/products`).set(O).send({ name: 'Yangi mahsulot' })).status).toBe(201);
  });
});
