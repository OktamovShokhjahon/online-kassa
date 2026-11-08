import { describe, expect, it } from 'vitest';
import { AuditLog, Branch, Shop, Terminal, User } from '../src/models/core';
import { expireShops } from '../src/workers/shopExpiry';
import { P, api, bearer, createShop, login, shopPayload, superSession } from './helpers';

describe('create shop (spec 4.2)', () => {
  it('creates shop + first branch + admin atomically; the admin sees only their shop', async () => {
    const sa = await superSession();
    const payload = shopPayload({ currency: 'USD', adminPhone: '90 123-45-67', firstBranchName: 'Chilonzor' });
    const r = await api().post(`${P}/admin/shops`).set(bearer(sa.token)).send(payload);
    expect(r.status).toBe(201);
    expect(r.body.data.shop.currency).toBe('USD');
    expect(r.body.data.shop.fiscalEnabled).toBe(false);
    expect(r.body.data.admin.phone).toBe('+998901234567'); // stored as E.164
    expect(r.body.data.branch.name).toBe('Chilonzor');
    expect(JSON.stringify(r.body)).not.toContain('password123');

    const admin = await login(payload.adminLogin as string, payload.adminPassword as string);
    expect(admin.body.shop.id).toBe(r.body.data.shop.id);
    expect(admin.body.user.role).toBe('shop_admin');
    // default limits come from platform settings
    const shop = await Shop.findById(r.body.data.shop.id);
    expect(shop!.limits).toMatchObject({ maxBranches: 3, maxTerminals: 5, maxEmployees: 20 });
  });

  it('defaults to UZS, fiscal off, trial', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    expect(s.admin.body.shop).toMatchObject({ currency: 'UZS', fiscalEnabled: false, status: 'trial' });
  });

  it('enforces unique logins platform-wide, case-insensitively', async () => {
    const sa = await superSession();
    await createShop(sa.token, { adminLogin: 'Owner.One' });
    const dup = await api().post(`${P}/admin/shops`).set(bearer(sa.token)).send(shopPayload({ adminLogin: 'owner.one' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LOGIN_TAKEN');
    // the failed create left nothing behind (no orphan shop)
    expect(await Shop.countDocuments({})).toBe(1);
  });

  it('validates fields and requires TIN when fiscal receipts are on', async () => {
    const sa = await superSession();
    const post = (b: Record<string, unknown>) => api().post(`${P}/admin/shops`).set(bearer(sa.token)).send(shopPayload(b));
    expect((await post({ adminPassword: 'short' })).status).toBe(400);
    expect((await post({ adminLogin: 'ab' })).status).toBe(400);
    expect((await post({ adminPhone: '123' })).status).toBe(400);
    expect((await post({ name: 'x' })).status).toBe(400);
    expect((await post({ currency: 'EUR' })).status).toBe(400);
    const noTin = await post({ fiscalEnabled: true });
    expect(noTin.status).toBe(400);
    expect(JSON.stringify(noTin.body.error.details)).toContain('TIN_REQUIRED');
    expect((await post({ fiscalEnabled: true, tin: '123456789' })).status).toBe(201);
  });

  it('writes a platform audit entry', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const logs = await api().get(`${P}/admin/audit-logs?action=shop.created`).set(bearer(sa.token));
    expect(logs.body.data.map((l: any) => l.entityId)).toContain(s.shopId);
  });
});

describe('shop list and details (spec 4.3)', () => {
  it('lists with search, status and fiscal filters', async () => {
    const sa = await superSession();
    const day = 86_400_000;
    const a = await createShop(sa.token, { name: 'Alpha Market', adminLogin: 'alpha_owner' });
    const b = await createShop(sa.token, { name: 'Beta Store', fiscalEnabled: true, tin: '123456789', paidUntil: new Date(Date.now() + 30 * day) });
    await createShop(sa.token, { name: 'Gamma', paidUntil: new Date(Date.now() - 30 * day) });
    await api().post(`${P}/admin/shops/${a.shopId}/block`).set(bearer(sa.token)).send({ reason: 'test' });

    const get = async (qs: string) => (await api().get(`${P}/admin/shops?${qs}`).set(bearer(sa.token))).body;
    expect((await get('')).meta.total).toBe(3);
    expect((await get('status=blocked')).data.map((s: any) => s.name)).toEqual(['Alpha Market']);
    expect((await get('status=active')).data.map((s: any) => s.name)).toEqual(['Beta Store']);
    expect((await get('status=expired')).data.map((s: any) => s.name)).toEqual(['Gamma']);
    expect((await get('fiscal=on')).data.map((s: any) => s.name)).toEqual(['Beta Store']);
    expect((await get('q=alpha_owner')).data.map((s: any) => s.name)).toEqual(['Alpha Market']); // admin login search
    expect((await get('q=beta')).data[0].id).toBe(b.shopId);
    expect((await get('limit=2')).data).toHaveLength(2);
  });

  it('details include admin, branches, terminals with agent status, payments', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    await Terminal.create({ shopId: s.shopId, branchId: s.branchId, name: 'Kassa 1', lastSeenAt: new Date() });
    const r = await api().get(`${P}/admin/shops/${s.shopId}`).set(bearer(sa.token));
    expect(r.status).toBe(200);
    expect(r.body.data.admin.login).toBe(s.payload.adminLogin);
    expect(r.body.data.branches).toHaveLength(1);
    expect(r.body.data.terminals[0].online).toBe(true);
    expect(r.body.data.terminals[0].agentTokenHash).toBeUndefined();
    expect(r.body.data.admin.passwordHash).toBeUndefined();
  });

  it('edits profile and limits; 404 for unknown shop', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const r = await api().patch(`${P}/admin/shops/${s.shopId}`).set(bearer(sa.token)).send({ name: 'Renamed', limits: { maxBranches: 10 } });
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe('Renamed');
    expect(r.body.data.limits.maxBranches).toBe(10);
    expect(r.body.data.limits.maxTerminals).toBe(5);
    expect((await api().get(`${P}/admin/shops/64b000000000000000000000`).set(bearer(sa.token))).status).toBe(404);
    expect((await api().get(`${P}/admin/shops/not-an-id`).set(bearer(sa.token))).status).toBe(400);
  });
});

describe('payments, expiry, blocking (spec 4.5)', () => {
  it('recording a payment extends paid-until and never moves it backwards', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const pay = (periodTo: string) =>
      api().post(`${P}/admin/shops/${s.shopId}/payments`).set(bearer(sa.token)).send({
        amount: 15_000_000, currency: 'UZS', periodFrom: '2026-11-01', periodTo, paidAt: '2026-11-06', method: 'bank_transfer', comment: 'Nov',
      });
    const r1 = await pay('2026-12-01');
    expect(r1.status).toBe(201);
    expect(new Date(r1.body.data.paidUntil).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    await pay('2026-11-15');
    expect(new Date((await Shop.findById(s.shopId))!.paidUntil!).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    const list = await api().get(`${P}/admin/shops/${s.shopId}/payments`).set(bearer(sa.token));
    expect(list.body.meta.total).toBe(2);
    expect((await api().post(`${P}/admin/shops/${s.shopId}/payments`).set(bearer(sa.token)).send({ amount: 1.5 })).status).toBe(400);
  });

  it('blocking revokes sessions and agent tokens at once and keeps data', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    await Terminal.create({ shopId: s.shopId, branchId: s.branchId, name: 'K1', agentTokenHash: 'abc' });
    const r = await api().post(`${P}/admin/shops/${s.shopId}/block`).set(bearer(sa.token)).send({ reason: 'chargeback' });
    expect(r.body.data.status).toBe('blocked');
    expect((await Terminal.findOne({ shopId: s.shopId }))!.agentTokenHash).toBeUndefined();
    expect(await Branch.countDocuments({ shopId: s.shopId })).toBe(1);
    expect(await User.countDocuments({ shopId: s.shopId })).toBe(1);

    const again = await api().post(`${P}/admin/shops/${s.shopId}/block`).set(bearer(sa.token)).send({ reason: 'again' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('SHOP_ALREADY_BLOCKED');
    expect((await api().post(`${P}/admin/shops/${s.shopId}/block`).set(bearer(sa.token)).send({})).status).toBe(400);

    const un = await api().post(`${P}/admin/shops/${s.shopId}/unblock`).set(bearer(sa.token));
    expect(un.body.data.status).toBe('active');
    expect((await api().post(`${P}/admin/shops/${s.shopId}/unblock`).set(bearer(sa.token))).status).toBe(422);
  });

  it('expiry worker revokes sessions of shops past the grace period, idempotently', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    expect(await expireShops()).toBe(0);
    await Shop.updateOne({ _id: s.shopId }, { paidUntil: new Date(Date.now() - 10 * 86_400_000) });
    expect(await expireShops()).toBe(1);
    expect(await expireShops()).toBe(0);
    const cookie = s.admin.cookies.map((c) => c.split(';')[0]).join('; ');
    expect((await api().post(`${P}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
  });

  it('platform grace days setting changes behaviour', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    await Shop.updateOne({ _id: s.shopId }, { paidUntil: new Date(Date.now() - 2 * 86_400_000) });
    await login(s.payload.adminLogin as string, s.payload.adminPassword as string); // default grace 3d: ok
    await api().patch(`${P}/admin/settings`).set(bearer(sa.token)).send({ graceDays: 1 }).expect(200);
    const r = await api().post(`${P}/auth/login`).send({ login: s.payload.adminLogin, password: s.payload.adminPassword });
    expect(r.body.error.code).toBe('SHOP_EXPIRED');
  });
});

describe('fiscal toggle (spec 4.4)', () => {
  it('turns fiscal on only with a TIN, off without touching data; audited', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const bad = await api().patch(`${P}/admin/shops/${s.shopId}/fiscal`).set(bearer(sa.token)).send({ fiscalEnabled: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('TIN_REQUIRED');
    const on = await api().patch(`${P}/admin/shops/${s.shopId}/fiscal`).set(bearer(sa.token)).send({ fiscalEnabled: true, tin: '987654321' });
    expect(on.body.data).toEqual({ fiscalEnabled: true, tin: '987654321' });
    const off = await api().patch(`${P}/admin/shops/${s.shopId}/fiscal`).set(bearer(sa.token)).send({ fiscalEnabled: false });
    expect(off.body.data.fiscalEnabled).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'shop.fiscal_changed', shopId: null })).toBe(2);
  });

  it('a shop admin cannot toggle fiscal', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const r = await api().patch(`${P}/admin/shops/${s.shopId}/fiscal`).set(bearer(s.admin.token)).send({ fiscalEnabled: true, tin: '123456789' });
    expect(r.status).toBe(403);
  });
});

describe('admin accounts and impersonation (spec 4.3, 4.6)', () => {
  it('resets the admin password: shown once, old password and sessions die', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const r = await api().post(`${P}/admin/shops/${s.shopId}/reset-admin-password`).set(bearer(sa.token)).send({});
    expect(r.status).toBe(200);
    const pwd = r.body.data.newPassword as string;
    expect(pwd.length).toBeGreaterThanOrEqual(8);
    expect((await api().get(`${P}/auth/me`).set(bearer(s.admin.token))).status).toBe(401);
    expect((await api().post(`${P}/auth/login`).send({ login: s.payload.adminLogin, password: s.payload.adminPassword })).status).toBe(401);
    await login(s.payload.adminLogin as string, pwd);
    const log = await AuditLog.findOne({ shopId: null, action: 'shop.admin_password_reset' });
    expect(JSON.stringify(log)).not.toContain(pwd);
  });

  it('changes the shop admin: old admin deactivated, new admin works', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    const r = await api().post(`${P}/admin/shops/${s.shopId}/change-admin`).set(bearer(sa.token)).send({
      fullName: 'New Owner', phone: '+998935550000', login: 'newowner', password: 'brandnew123', language: 'ru',
    });
    expect(r.status).toBe(201);
    const nu = await login('newowner', 'brandnew123');
    expect(nu.body.shop.id).toBe(s.shopId);
    const old = await api().post(`${P}/auth/login`).send({ login: s.payload.adminLogin, password: s.payload.adminPassword });
    expect(old.status).toBe(403);
  });

  it('impersonation requires confirmation, is audited, and yields a shop-admin token with the imp claim', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    expect((await api().post(`${P}/admin/shops/${s.shopId}/impersonate`).set(bearer(sa.token)).send({})).status).toBe(400);
    const r = await api().post(`${P}/admin/shops/${s.shopId}/impersonate`).set(bearer(sa.token)).send({ confirm: true });
    expect(r.status).toBe(200);
    const me = await api().get(`${P}/auth/me`).set(bearer(r.body.data.accessToken));
    expect(me.body.data.shop.id).toBe(s.shopId);
    expect(me.body.data.impersonatedBy).toBeTruthy();
    expect(await AuditLog.countDocuments({ action: 'shop.impersonated', shopId: null })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'support.impersonation_started', shopId: s.shopId })).toBe(1);
  });

  it('cannot impersonate a blocked shop', async () => {
    const sa = await superSession();
    const s = await createShop(sa.token);
    await api().post(`${P}/admin/shops/${s.shopId}/block`).set(bearer(sa.token)).send({ reason: 'unpaid' });
    const r = await api().post(`${P}/admin/shops/${s.shopId}/impersonate`).set(bearer(sa.token)).send({ confirm: true });
    expect(r.status).toBe(403);
  });
});

describe('dashboard and settings (spec 4.1, 4.6)', () => {
  it('counts shops by status and surfaces expiring ones', async () => {
    const sa = await superSession();
    const day = 86_400_000;
    await createShop(sa.token); // trial
    await createShop(sa.token, { paidUntil: new Date(Date.now() + 3 * day) }); // active, expiring
    await createShop(sa.token, { paidUntil: new Date(Date.now() + 60 * day) }); // active
    const blocked = await createShop(sa.token);
    await api().post(`${P}/admin/shops/${blocked.shopId}/block`).set(bearer(sa.token)).send({ reason: 'unpaid' });
    const r = await api().get(`${P}/admin/dashboard`).set(bearer(sa.token));
    expect(r.body.data.shops).toMatchObject({ total: 4, trial: 1, active: 2, blocked: 1, expired: 0, expiringIn7Days: 1 });
    expect(r.body.data.attention).toHaveLength(1);
  });

  it('platform settings are readable and editable, and audited', async () => {
    const sa = await superSession();
    const r = await api().patch(`${P}/admin/settings`).set(bearer(sa.token)).send({ platformName: 'My Kass', defaultLimits: { maxBranches: 7 }, agentInstaller: { version: '1.2.3', url: 'https://x/agent.exe' } });
    expect(r.body.data.platformName).toBe('My Kass');
    expect(r.body.data.defaultLimits.maxBranches).toBe(7);
    expect(r.body.data.defaultLimits.maxTerminals).toBe(5);
    expect(r.body.data.agentInstaller.version).toBe('1.2.3');
    const s = await createShop(sa.token);
    expect((await Shop.findById(s.shopId))!.limits!.maxBranches).toBe(7);
    expect(await AuditLog.countDocuments({ shopId: null, action: 'platform.settings_changed' })).toBe(1);
  });
});
