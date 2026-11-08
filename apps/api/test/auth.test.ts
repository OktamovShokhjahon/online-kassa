import { describe, expect, it } from 'vitest';
import { Shop, User } from '../src/models/core';
import { P, api, bearer, createShop, login, superSession } from './helpers';

describe('auth', () => {
  it('logs in, returns role-based home and sets an httpOnly refresh cookie', async () => {
    const sa = await superSession();
    expect(sa.body.home).toBe('/superadmin');
    const shop = await createShop(sa.token);
    expect(shop.admin.body.home).toBe('/shop');
    const cookie = shop.admin.cookies.join(';');
    expect(cookie).toMatch(/kass_rt=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(JSON.stringify(shop.admin.body)).not.toMatch(/passwordHash|pinHash/);
  });

  it('rejects wrong credentials with a translated error (uz/ru/en) and stable code', async () => {
    await superSession();
    for (const [lang, text] of [
      ['en', 'Invalid login or password'],
      ['ru', 'Неверный логин или пароль'],
      ['uz', "Login yoki parol noto'g'ri"],
    ] as const) {
      const r = await api().post(`${P}/auth/login`).set('Accept-Language', lang).send({ login: 'root', password: 'bad-password' });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(r.body.error.message).toBe(text);
    }
  });

  it('locks a login after 5 failed attempts in 15 minutes, even with the right password', async () => {
    await superSession();
    for (let i = 0; i < 5; i++) {
      const r = await api().post(`${P}/auth/login`).send({ login: 'root', password: 'nope-nope' });
      expect(r.status).toBe(401);
    }
    const blocked = await api().post(`${P}/auth/login`).send({ login: 'root', password: 'rootpass123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('validates input and blocks NoSQL operator injection', async () => {
    await superSession();
    const injected = await api().post(`${P}/auth/login`).send({ login: { $ne: '' }, password: { $ne: '' } });
    expect(injected.status).toBe(400);
    const missing = await api().post(`${P}/auth/login`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /auth/me needs a token and returns the profile', async () => {
    const sa = await superSession();
    expect((await api().get(`${P}/auth/me`)).status).toBe(401);
    const me = await api().get(`${P}/auth/me`).set(bearer(sa.token));
    expect(me.status).toBe(200);
    expect(me.body.data.user.login).toBe('root');
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const sa = await superSession();
    const cookie1 = sa.cookies.map((c) => c.split(';')[0]).join('; ');
    const r1 = await api().post(`${P}/auth/refresh`).set('Cookie', cookie1);
    expect(r1.status).toBe(200);
    expect(r1.body.data.accessToken).toBeTruthy();
    const cookie2 = (r1.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    expect(cookie2).not.toBe(cookie1);

    // the same old token right away = a parallel tab / request racing the rotation: tolerated, no new cookie
    const racing = await api().post(`${P}/auth/refresh`).set('Cookie', cookie1);
    expect(racing.status).toBe(200);
    expect(racing.headers['set-cookie']?.toString() ?? '').not.toContain('kass_rt=');
    const { Session } = await import('../src/models/core');
    // later replay of the rotated-out token -> theft assumed, whole session dies
    await Session.updateMany({}, { $set: { rotatedAt: new Date(Date.now() - 120_000) } }).setOptions({ crossTenant: true });
    const replay = await api().post(`${P}/auth/refresh`).set('Cookie', cookie1);
    expect(replay.status).toBe(401);
    const afterTheft = await api().post(`${P}/auth/refresh`).set('Cookie', cookie2);
    expect(afterTheft.status).toBe(401);
    // and the access token tied to that session no longer works
    expect((await api().get(`${P}/auth/me`).set(bearer(r1.body.data.accessToken))).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const sa = await superSession();
    const cookie = sa.cookies.map((c) => c.split(';')[0]).join('; ');
    await api().post(`${P}/auth/logout`).set('Cookie', cookie).expect(200);
    expect((await api().post(`${P}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);
    expect((await api().get(`${P}/auth/me`).set(bearer(sa.token))).status).toBe(401);
  });

  it('change-password verifies the old password and kills all sessions', async () => {
    const sa = await superSession();
    const bad = await api().post(`${P}/auth/change-password`).set(bearer(sa.token)).send({ currentPassword: 'wrong', newPassword: 'newpassword1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('WRONG_PASSWORD');
    await api().post(`${P}/auth/change-password`).set(bearer(sa.token)).send({ currentPassword: 'rootpass123', newPassword: 'newpassword1' }).expect(200);
    expect((await api().get(`${P}/auth/me`).set(bearer(sa.token))).status).toBe(401);
    await login('root', 'newpassword1');
  });

  it('stores the preferred language per user', async () => {
    const sa = await superSession();
    await api().patch(`${P}/auth/language`).set(bearer(sa.token)).send({ language: 'ru' }).expect(200);
    expect((await User.findOne({ login: 'root' }).setOptions({ crossTenant: true }))!.language).toBe('ru');
    await api().patch(`${P}/auth/language`).set(bearer(sa.token)).send({ language: 'de' }).expect(400);
  });

  it('a deactivated employee cannot log in and an existing token stops working', async () => {
    const sa = await superSession();
    const shop = await createShop(sa.token);
    await User.updateOne({ _id: shop.adminId, shopId: shop.shopId }, { isActive: false });
    const r = await api().post(`${P}/auth/login`).send({ login: shop.payload.adminLogin, password: shop.payload.adminPassword });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('USER_INACTIVE');
    expect((await api().get(`${P}/auth/me`).set(bearer(shop.admin.token))).status).toBe(403);
  });
});

describe('shop status gate (spec 4.5)', () => {
  it('refuses login for a blocked shop with a clear message, then works again after unblock', async () => {
    const sa = await superSession();
    const shop = await createShop(sa.token);
    await api().post(`${P}/admin/shops/${shop.shopId}/block`).set(bearer(sa.token)).send({ reason: 'unpaid' }).expect(200);

    const r = await api().post(`${P}/auth/login`).set('Accept-Language', 'ru').send({ login: shop.payload.adminLogin, password: shop.payload.adminPassword });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SHOP_BLOCKED');
    expect(r.body.error.message).toContain('заблокирован');
    // existing access token and refresh are dead immediately (sessions revoked on block)
    expect((await api().get(`${P}/auth/me`).set(bearer(shop.admin.token))).status).toBe(401);
    const cookie = shop.admin.cookies.map((c) => c.split(';')[0]).join('; ');
    expect((await api().post(`${P}/auth/refresh`).set('Cookie', cookie)).status).toBe(401);

    await api().post(`${P}/admin/shops/${shop.shopId}/unblock`).set(bearer(sa.token)).expect(200);
    await login(shop.payload.adminLogin as string, shop.payload.adminPassword as string);
  });

  it('allows login during the grace period with a warning, refuses after it', async () => {
    const sa = await superSession();
    const shop = await createShop(sa.token);
    const day = 86_400_000;
    await Shop.updateOne({ _id: shop.shopId }, { paidUntil: new Date(Date.now() - 1 * day) });
    const inGrace = await login(shop.payload.adminLogin as string, shop.payload.adminPassword as string);
    expect(inGrace.body.graceDaysLeft).toBeGreaterThanOrEqual(1);
    expect(inGrace.body.shop.inGrace).toBe(true);

    await Shop.updateOne({ _id: shop.shopId }, { paidUntil: new Date(Date.now() - 10 * day) });
    const r = await api().post(`${P}/auth/login`).send({ login: shop.payload.adminLogin, password: shop.payload.adminPassword });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SHOP_EXPIRED');
  });

  it('trial shops (no paid-until) can log in', async () => {
    const sa = await superSession();
    const shop = await createShop(sa.token);
    expect(shop.admin.body.shop.status).toBe('trial');
  });
});
