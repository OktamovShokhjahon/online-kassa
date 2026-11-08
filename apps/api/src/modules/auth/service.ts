import bcrypt from 'bcryptjs';
import type { Role } from '@kass/shared';
import { env } from '../../config/env';
import { effectiveStatus, getGraceDays } from '../../lib/platform';
import type { ShopDoc, UserDoc } from '../../models/core';
import { effectivePermissions } from '../../middleware/auth';

export const hashSecret = (plain: string) => bcrypt.hash(plain, env.BCRYPT_COST);
export const compareSecret = (plain: string, hash: string) => bcrypt.compare(plain, hash);

let dummyHash: Promise<string> | null = null;
/** Compared against when the login does not exist, so response time does not reveal valid logins. */
export function burnPasswordCheck(plain: string) {
  dummyHash ??= bcrypt.hash('not-a-real-password', env.BCRYPT_COST);
  return dummyHash.then((hash) => bcrypt.compare(plain, hash));
}

export const homeFor = (role: Role): string =>
  role === 'superadmin' ? '/superadmin' : role === 'cashier' ? '/pos' : '/shop';

export function publicUser(user: UserDoc) {
  return {
    id: String(user._id),
    role: user.role,
    shopId: user.shopId ? String(user.shopId) : null,
    fullName: user.fullName,
    phone: user.phone,
    login: user.login,
    branchIds: (user.branchIds ?? []).map(String),
    permissions: [...effectivePermissions(user.role as Role, user.permissions)],
    language: user.language,
    hasPin: !!user.pinHash,
  };
}

export async function publicShop(shop: ShopDoc | null) {
  if (!shop) return null;
  const st = effectiveStatus(shop, await getGraceDays());
  return {
    id: String(shop._id),
    name: shop.name,
    currency: shop.currency,
    currencyLocked: shop.currencyLocked,
    fiscalEnabled: shop.fiscalEnabled,
    logoUrl: shop.logoUrl,
    status: st.status,
    inGrace: st.inGrace,
    graceDaysLeft: st.graceDaysLeft,
    paidUntil: shop.paidUntil,
    settings: shop.settings,
  };
}
