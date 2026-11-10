import { Router } from 'express';
import { z } from 'zod';
import {
  changePasswordBodySchema,
  languageBodySchema,
  loginBodySchema,
  pinLoginBodySchema,
  type Role,
} from '@kass/shared';
import { env } from '../../config/env';
import { audit, auditSystem } from '../../lib/audit';
import { badRequest, forbidden, tooMany, unauthorized } from '../../lib/errors';
import { auth, h, ok } from '../../lib/http';
import * as limiter from '../../lib/rateLimit';
import { randomToken, sha256 } from '../../lib/crypto';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  createSession,
  revokeUserSessions,
  setRefreshCookie,
  setRoleCookie,
  signAccessToken,
} from '../../lib/tokens';
import { assertShopUsable, authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Session, Shop, Terminal, User, type ShopDoc, type UserDoc } from '../../models/core';
import { burnPasswordCheck, compareSecret, hashSecret, homeFor, publicShop, publicUser, sealPassword } from './service';

/** How long the just-rotated refresh token is still accepted (requests racing the rotation). */
const REFRESH_RACE_MS = 60_000;

export const authRouter = Router();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 5;
const MAX_PIN_FAILED = 10;

async function loadShop(user: UserDoc): Promise<ShopDoc | null> {
  return user.role === 'superadmin' ? null : ((await Shop.findById(user.shopId)) as ShopDoc | null);
}

async function authPayload(user: UserDoc, shop: ShopDoc | null, extra: Record<string, unknown> = {}) {
  const st = shop ? await assertShopUsable(shop) : null;
  return {
    user: publicUser(user),
    shop: await publicShop(shop),
    graceDaysLeft: st?.graceDaysLeft ?? null,
    home: homeFor(user.role as Role),
    ...extra,
  };
}

/** Step 1-4 of spec 3.2. */
authRouter.post(
  '/login',
  validate({ body: loginBodySchema }),
  h(async (req, res) => {
    const { login, password, language } = req.body as z.infer<typeof loginBodySchema>;
    const key = `login:${login.toLowerCase()}`;

    if ((await limiter.peek(key)) >= MAX_FAILED) throw tooMany('TOO_MANY_ATTEMPTS');

    const user = await User.findOne({ login: login.toLowerCase() }).setOptions({ crossTenant: true });
    const valid = user ? await compareSecret(password, user.passwordHash) : await burnPasswordCheck(password);
    if (!user || !valid) {
      await limiter.hit(key, WINDOW_MS);
      await auditSystem({
        action: 'auth.login_failed',
        entity: 'user',
        meta: { login: login.toLowerCase() },
        shopId: user?.shopId ?? null,
        ip: req.ip,
      });
      throw unauthorized('INVALID_CREDENTIALS');
    }
    if (!user.isActive) throw forbidden('USER_INACTIVE');
    // passwords set before they were kept become visible to the owner after the next sign-in
    if (user.role !== 'superadmin' && !user.passwordEnc) await User.updateOne({ _id: user._id }, { $set: { passwordEnc: sealPassword(password) } }).setOptions({ crossTenant: true });

    const shop = await loadShop(user);
    if (user.role !== 'superadmin') await assertShopUsable(shop);

    await limiter.reset(key);
    if (language && language !== user.language) user.language = language;
    user.lastLoginAt = new Date();
    await user.save();

    const { session, refreshToken } = await createSession(user, req);
    setRefreshCookie(res, refreshToken);
    setRoleCookie(res, user.role);
    const accessToken = signAccessToken(user, { sessionId: String(session._id) });

    req.auth = { kind: 'user', userId: user._id, role: user.role as Role, shopId: user.shopId ?? null, user } as any;
    await audit(req, { action: 'auth.login', entity: 'user', entityId: user._id, shopId: user.shopId ?? null });

    ok(res, { accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, ...(await authPayload(user, shop)) });
  }),
);

/** Rotating refresh tokens with reuse detection. */
authRouter.post(
  '/refresh',
  h(async (req, res) => {
    const raw: string | undefined = req.cookies?.[REFRESH_COOKIE];
    if (!raw || !raw.includes('.')) throw unauthorized('INVALID_TOKEN');
    const [sid, secret] = raw.split('.', 2);
    if (!/^[a-f\d]{24}$/i.test(sid ?? '')) throw unauthorized('INVALID_TOKEN');

    const session = await Session.findById(sid);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      clearRefreshCookie(res);
      throw unauthorized('INVALID_TOKEN');
    }
    const hash = sha256(secret ?? '');
    // The token that was rotated a moment ago comes back: another tab or a parallel request of the same
    // browser raced the rotation. Answer with an access token and leave the newer cookie in place.
    const racing = session.tokenHash !== hash && session.prevTokenHash === hash && !!session.rotatedAt && Date.now() - session.rotatedAt.getTime() < REFRESH_RACE_MS;
    if (session.tokenHash !== hash && !racing) {
      if (session.prevTokenHash === hash) {
        // An already-rotated token was presented again: assume theft and kill the session.
        session.revokedAt = new Date();
        await session.save();
        await auditSystem({ action: 'auth.refresh_reuse_detected', entity: 'session', entityId: session._id, shopId: session.shopId, userId: session.userId, ip: req.ip });
      }
      clearRefreshCookie(res);
      throw unauthorized('INVALID_TOKEN');
    }

    const user = await User.findOne({ _id: session.userId }).setOptions({ crossTenant: true });
    if (!user) throw unauthorized('INVALID_TOKEN');
    if (!user.isActive) throw forbidden('USER_INACTIVE');
    const shop = await loadShop(user);
    if (user.role !== 'superadmin') await assertShopUsable(shop);

    if (!racing) {
      const next = randomToken(32);
      session.prevTokenHash = session.tokenHash;
      session.tokenHash = sha256(next);
      session.rotatedAt = new Date();
      session.expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
      await session.save();
      setRefreshCookie(res, `${session._id}.${next}`);
    }
    setRoleCookie(res, user.role);

    ok(res, {
      accessToken: signAccessToken(user, { sessionId: String(session._id) }),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      ...(await authPayload(user, shop)),
    });
  }),
);

authRouter.post(
  '/logout',
  h(async (req, res) => {
    const raw: string | undefined = req.cookies?.[REFRESH_COOKIE];
    const sid = raw?.split('.')[0];
    if (sid && /^[a-f\d]{24}$/i.test(sid)) {
      await Session.updateOne({ _id: sid, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    clearRefreshCookie(res);
    ok(res, { ok: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  h(async (req, res) => {
    const a = auth(req);
    ok(res, await authPayload(a.user, a.shop, { impersonatedBy: a.impersonatedBy ?? null }));
  }),
);

/**
 * Quick cashier switch on an already authorised terminal: the caller must hold a valid session
 * of the same shop. Attempts are limited per terminal.
 */
authRouter.post(
  '/pin-login',
  authenticate,
  validate({ body: pinLoginBodySchema }),
  h(async (req, res) => {
    const a = auth(req);
    if (!a.shopId) throw forbidden();
    const { terminalId, login, pin } = req.body as z.infer<typeof pinLoginBodySchema>;

    const key = `pin:${terminalId}`;
    if ((await limiter.peek(key)) >= MAX_PIN_FAILED) throw tooMany('TOO_MANY_ATTEMPTS');

    const terminal = await Terminal.findOne({ _id: terminalId, shopId: a.shopId, isActive: true });
    if (!terminal) throw badRequest('NOT_FOUND');

    const target = await User.findOne({ login: login.toLowerCase(), shopId: a.shopId, isActive: true });
    const valid = !!target?.pinHash && (await compareSecret(pin, target.pinHash));
    const branchOk =
      !!target &&
      (target.role === 'shop_admin' || (target.branchIds ?? []).some((b) => String(b) === String(terminal.branchId)));
    if (!target || !valid || !branchOk) {
      await limiter.hit(key, WINDOW_MS);
      throw unauthorized('PIN_INVALID');
    }
    await limiter.reset(key);

    target.lastLoginAt = new Date();
    await target.save();
    const { session, refreshToken } = await createSession(target, req);
    setRefreshCookie(res, refreshToken);
    setRoleCookie(res, target.role);
    req.auth = { ...a, userId: target._id, role: target.role as Role, user: target } as any;
    await audit(req, { action: 'auth.pin_login', entity: 'user', entityId: target._id, meta: { terminalId } });
    ok(res, {
      accessToken: signAccessToken(target, { sessionId: String(session._id) }),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      ...(await authPayload(target, a.shop)),
    });
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordBodySchema }),
  h(async (req, res) => {
    const a = auth(req);
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordBodySchema>;
    if (!(await compareSecret(currentPassword, a.user.passwordHash))) throw badRequest('WRONG_PASSWORD');
    a.user.passwordHash = await hashSecret(newPassword);
    if (a.user.role !== 'superadmin') a.user.passwordEnc = sealPassword(newPassword);
    a.user.permVersion += 1;
    await a.user.save();
    await revokeUserSessions(a.userId);
    await audit(req, { action: 'auth.password_changed', entity: 'user', entityId: a.userId });
    // Old sessions and access tokens are now invalid; the client logs in again.
    clearRefreshCookie(res);
    ok(res, { ok: true });
  }),
);

authRouter.patch(
  '/language',
  authenticate,
  validate({ body: languageBodySchema }),
  h(async (req, res) => {
    const a = auth(req);
    a.user.language = req.body.language;
    await a.user.save();
    ok(res, { language: a.user.language });
  }),
);
