import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { randomToken, sha256 } from './crypto';
import { Session, type UserDoc } from '../models/core';

export const REFRESH_COOKIE = 'kass_rt';

export interface AccessPayload {
  typ: 'access';
  sub: string;
  role: string;
  shopId: string | null;
  branchIds: string[];
  /** Permissions version; a mismatch forces the client to refresh its token. */
  pv: number;
  sid?: string;
  imp?: string;
}

export function signAccessToken(
  user: UserDoc,
  opts: { sessionId?: string; impersonatedBy?: string; ttlSeconds?: number } = {},
): string {
  const payload: AccessPayload = {
    typ: 'access',
    sub: String(user._id),
    role: user.role,
    shopId: user.shopId ? String(user.shopId) : null,
    branchIds: (user.branchIds ?? []).map(String),
    pv: user.permVersion,
    sid: opts.sessionId,
    imp: opts.impersonatedBy,
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: opts.ttlSeconds ?? env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  const p = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  if (p.typ !== 'access') throw new Error('wrong token type');
  return p;
}

/** Opaque refresh token = `<sessionId>.<random>`; only a hash of it is stored. */
export async function createSession(
  user: UserDoc,
  req: Request,
  extra: { impersonatedBy?: Types.ObjectId; ttlDays?: number } = {},
) {
  const secret = randomToken(32);
  const ttlDays = extra.ttlDays ?? env.REFRESH_TOKEN_TTL_DAYS;
  const session = await Session.create({
    userId: user._id,
    shopId: user.shopId ?? null,
    tokenHash: sha256(secret),
    device: String(req.headers['user-agent'] ?? '').slice(0, 200),
    ip: req.ip,
    expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    impersonatedBy: extra.impersonatedBy,
  });
  return { session, refreshToken: `${session._id}.${secret}` };
}

/** Non-secret role hint for Next.js route protection; the API checks every request itself. */
export const ROLE_COOKIE = 'kass_role';
export function setRoleCookie(res: Response, role: string) {
  res.cookie(ROLE_COOKIE, role, { httpOnly: false, secure: env.cookieSecure, sameSite: 'lax', path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(ROLE_COOKIE, { path: '/' });
}

/** Revoke every active session of a user (password change, deactivation) or a whole shop. */
export async function revokeUserSessions(userId: Types.ObjectId, exceptSessionId?: string) {
  const filter: Record<string, unknown> = { userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  await Session.updateMany(filter, { $set: { revokedAt: new Date() } });
}

export async function revokeShopSessions(shopId: Types.ObjectId) {
  await Session.updateMany({ shopId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
