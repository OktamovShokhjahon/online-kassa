import type { Request, RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { ROLE_DEFAULT_PERMISSIONS, type Role } from '@kass/shared';
import { forbidden, unauthorized } from '../lib/errors';
import { h } from '../lib/http';
import { effectiveStatus, getGraceDays } from '../lib/platform';
import { verifyAccessToken } from '../lib/tokens';
import { Session, Shop, User, type ShopDoc } from '../models/core';
import type { AuthContext } from '../types';

/** Throws SHOP_BLOCKED / SHOP_EXPIRED unless the shop may be used (active, trial or in grace). */
export async function assertShopUsable(shop: ShopDoc | null | undefined) {
  if (!shop) throw forbidden('SHOP_BLOCKED');
  const st = effectiveStatus(shop, await getGraceDays());
  if (st.status === 'blocked') throw forbidden('SHOP_BLOCKED');
  if (st.status === 'expired') throw forbidden('SHOP_EXPIRED');
  return st;
}

export function effectivePermissions(role: Role, extra: string[] = []): Set<string> {
  return new Set<string>([...ROLE_DEFAULT_PERMISSIONS[role], ...extra]);
}

/**
 * Steps 3-4 of the middleware chain (spec 13.3): verify the JWT, load the user fresh (so
 * deactivation and permission changes apply immediately), then run the tenant check.
 */
export const authenticate: RequestHandler = h(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  let payload;
  try {
    payload = verifyAccessToken(header.slice(7));
  } catch {
    throw unauthorized('INVALID_TOKEN');
  }

  const user = await User.findOne({ _id: payload.sub }).setOptions({ crossTenant: true });
  if (!user) throw unauthorized('INVALID_TOKEN');
  if (!user.isActive) throw forbidden('USER_INACTIVE');
  if (user.permVersion !== payload.pv) throw unauthorized('INVALID_TOKEN');

  if (payload.sid) {
    const session = await Session.findOne({ _id: payload.sid, revokedAt: null, expiresAt: { $gt: new Date() } })
      .select('_id')
      .lean();
    if (!session) throw unauthorized('INVALID_TOKEN');
  }

  let shop: ShopDoc | null = null;
  let graceDaysLeft: number | null = null;
  if (user.role !== 'superadmin') {
    shop = (await Shop.findById(user.shopId)) as ShopDoc | null;
    const st = await assertShopUsable(shop);
    graceDaysLeft = st.graceDaysLeft;
  }

  const ctx: AuthContext = {
    kind: 'user',
    userId: user._id,
    role: user.role as Role,
    shopId: user.shopId ?? null,
    branchIds: (user.branchIds ?? []) as Types.ObjectId[],
    permissions: effectivePermissions(user.role as Role, user.permissions),
    user,
    shop,
    sessionId: payload.sid,
    impersonatedBy: payload.imp,
    graceDaysLeft,
  };
  req.auth = ctx;
  next();
});

export const requireRole = (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    next();
  };

export function can(a: AuthContext, permission: string): boolean {
  if (a.role === 'superadmin') return false; // superadmin never works inside a shop
  if (a.role === 'shop_admin') return true;
  return a.permissions.has(permission);
}

/** Step 5: permission check. A user needs at least one of the listed permission codes. */
export const requirePermission = (...codes: string[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!codes.some((c) => can(req.auth!, c))) return next(forbidden());
    next();
  };

/** Roles + permission in one go. The shop admin always passes the permission part. */
export const shopUser: RequestHandler[] = [authenticate, (req, _res, next) => {
  if (!req.auth?.shopId) return next(forbidden());
  next();
}];

/** Step 6: branch scope. Shop admins reach every branch; others only their assigned ones. */
export function canAccessBranch(a: AuthContext, branchId: string | Types.ObjectId): boolean {
  if (a.role === 'shop_admin') return true;
  return a.branchIds.some((b) => String(b) === String(branchId));
}

export function assertBranchAccess(req: Request, branchId: string | Types.ObjectId) {
  if (!req.auth || !canAccessBranch(req.auth, branchId)) throw forbidden();
}

/** Mongo condition restricting a `branchId` field to the caller's branches (empty for admins). */
export function branchScope(a: AuthContext, field = 'branchId'): Record<string, unknown> {
  if (a.role === 'shop_admin') return {};
  return { [field]: { $in: a.branchIds } };
}
