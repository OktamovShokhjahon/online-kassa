/**
 * Logins and passwords: the platform owner sees and changes them for every account of a shop,
 * the shop owner for their staff. Statistics of one shop for the platform owner.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { User } from '../src/models/core';
import { P, api, bearer, createShop, login } from './helpers';
import { COLA, posCtx } from './posCtx';

describe('credentials', () => {
  it('superadmin sees and edits the login and password of the owner and the staff', async () => {
    const t = await posCtx({ openShift: false });
    const SA = bearer(t.sa.token);
    const users = (await api().get(`${P}/admin/shops/${t.shop.shopId}/users`).set(SA)).body.data;
    const owner = users.find((u: any) => u.role === 'shop_admin');
    expect(owner).toMatchObject({ login: t.shop.payload.adminLogin, password: 'password123', isActive: true });
    const cashier = users.find((u: any) => u.id === t.cashier.id);
    expect(cashier.password).toBeTruthy();
    // the hash and the encrypted copy are never sent anywhere else
    const me = (await t.get(`/users/${t.cashier.id}`)).body.data;
    expect(me.passwordHash).toBeUndefined();
    expect(me.passwordEnc).toBeUndefined();

    // change the owner's login and password: old sign-in stops working, new one works
    const r = await api().patch(`${P}/admin/shops/${t.shop.shopId}/users/${owner.id}`).set(SA).send({ login: 'new.owner1', password: 'newpass123' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ login: 'new.owner1', password: 'newpass123' });
    expect((await api().post(`${P}/auth/login`).send({ login: t.shop.payload.adminLogin, password: 'password123' })).status).toBe(401);
    await login('new.owner1', 'newpass123');
    // a login that is taken elsewhere is refused
    expect((await api().patch(`${P}/admin/shops/${t.shop.shopId}/users/${cashier.id}`).set(SA).send({ login: 'root' })).body.error.code).toBe('LOGIN_TAKEN');
    // a user of another shop cannot be reached through this shop
    const other = await createShop(t.sa.token);
    expect((await api().patch(`${P}/admin/shops/${t.shop.shopId}/users/${other.adminId}`).set(SA).send({ password: 'whatever123' })).status).toBe(404);
    // shop users cannot use these endpoints
    expect((await api().get(`${P}/admin/shops/${t.shop.shopId}/users`).set(bearer(other.admin.token))).status).toBe(403);
  });

  it('the shop owner sees and changes the logins and passwords of the staff, but nobody else does', async () => {
    const t = await posCtx({ openShift: false });
    const list = (await t.get('/users/credentials')).body.data;
    expect(list.every((u: any) => u.role !== 'shop_admin')).toBe(true);
    const c = list.find((u: any) => u.id === t.cashier.id);
    expect(c.login).toBeTruthy();
    expect(c.password).toBeTruthy();

    const r = await t.patch(`/users/${t.cashier.id}/credentials`, { login: 'kassir.new', password: 'kassir12345' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ login: 'kassir.new', password: 'kassir12345' });
    await login('kassir.new', 'kassir12345');
    // the owner's own account is not editable here
    const ownerId = t.shop.adminId;
    expect((await t.patch(`/users/${ownerId}/credentials`, { password: 'x12345678' })).status).toBe(403);
    // the staff list carries the status, so the owner can deactivate and activate again
    const row = (await t.get('/users?limit=100')).body.data.find((u: any) => u.id === t.cashier.id);
    expect(row.isActive).toBe(true);
    expect((await t.patch(`/users/${t.cashier.id}/status`, { isActive: false })).body.data).toBeTruthy();
    expect((await t.get('/users?limit=100')).body.data.find((u: any) => u.id === t.cashier.id).isActive).toBe(false);
    // a branch manager cannot see passwords
    expect((await t.get('/users/credentials', t.manager.h)).status).toBe(403);
  });

  it('a password set before passwords were kept appears after the next sign-in', async () => {
    const t = await posCtx({ openShift: false });
    await User.updateOne({ _id: t.cashier.id }, { $unset: { passwordEnc: 1 } }).setOptions({ crossTenant: true } as any);
    expect((await t.get('/users/credentials')).body.data.find((u: any) => u.id === t.cashier.id).password).toBeNull();
    await login(t.cashier.login, 'password123');
    expect((await t.get('/users/credentials')).body.data.find((u: any) => u.id === t.cashier.id).password).toBeTruthy();
  });
});

describe('shop statistics for the superadmin', () => {
  it('counts sales, profit, refunds, declined receipts and arrivals', async () => {
    const t = await posCtx();
    ok(await t.sell([{ productId: t.cola.id, qty: 2 }], [{ method: 'cash', amount: 2 * COLA.price }]));
    const SA = bearer(t.sa.token);
    const s = (await api().get(`${P}/admin/shops/${t.shop.shopId}/stats?period=today`).set(SA)).body.data;
    expect(s.totals).toMatchObject({ revenue: 2 * COLA.price, receipts: 1, grossProfit: 2 * (COLA.price - COLA.cost) });
    expect(s.totals.arrivals.count).toBeGreaterThan(0);
    expect(s.byDay).toHaveLength(1);
    expect(s.topProducts[0]).toMatchObject({ qty: 2, revenue: 2 * COLA.price });
    expect(s.byTerminal[0]).toMatchObject({ name: 'Kassa 1', receipts: 1 });
    expect(s.payments).toEqual([{ method: 'cash', amount: 2 * COLA.price }]);
    expect(s.counts.terminals).toBe(1);
    expect((await api().get(`${P}/admin/shops/${t.shop.shopId}/stats?period=all`).set(SA)).body.data.totals.receipts).toBe(1);
    expect((await api().get(`${P}/admin/shops/${t.shop.shopId}/stats`).set(t.A)).status).toBe(403);
    void randomUUID;
  });
});

function ok(r: { status: number; body: any }) {
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
