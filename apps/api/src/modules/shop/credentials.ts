import type { z } from 'zod';
import type { userCredentialsSchema } from '@kass/shared';
import { conflict } from '../../lib/errors';
import { revokeUserSessions } from '../../lib/tokens';
import { User, type UserDoc } from '../../models/core';
import { hashSecret, publicUser, revealPassword, sealPassword } from '../auth/service';

/** A user with the login and (when known) the password, for the superadmin and the shop owner. */
export function withCredentials(u: UserDoc) {
  return {
    ...publicUser(u),
    isActive: u.isActive,
    lastLoginAt: (u as any).lastLoginAt ?? null,
    password: revealPassword(u as any),
  };
}

/**
 * Changes login / password / name. A new login or password signs the user out everywhere
 * (old tokens stop working); the new password is kept encrypted so it stays visible.
 */
export async function applyCredentials(u: UserDoc, b: z.infer<typeof userCredentialsSchema>) {
  let signOut = false;
  if (b.login !== undefined && b.login.toLowerCase() !== u.login) {
    const login = b.login.toLowerCase();
    if (await User.exists({ login, _id: { $ne: u._id } }).setOptions({ crossTenant: true })) throw conflict('LOGIN_TAKEN');
    u.login = login;
    signOut = true;
  }
  if (b.password !== undefined) {
    u.passwordHash = await hashSecret(b.password);
    u.passwordEnc = sealPassword(b.password);
    signOut = true;
  }
  if (b.fullName !== undefined) u.fullName = b.fullName;
  if (signOut) u.permVersion += 1;
  await u.save();
  if (signOut) await revokeUserSessions(u._id);
  return { changedLogin: b.login !== undefined, changedPassword: b.password !== undefined };
}
