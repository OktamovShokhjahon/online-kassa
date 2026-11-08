import { env } from '../config/env';
import { connectDb, disconnectDb } from '../db/connect';
import { User } from '../models/core';
import { hashSecret } from '../modules/auth/service';

/**
 * One-time seed (spec 2, 14.6). Creates the platform superadmin from environment variables:
 *   SUPERADMIN_LOGIN, SUPERADMIN_PASSWORD [, SUPERADMIN_FULL_NAME]
 * Safe to re-run: it does nothing if a superadmin with that login already exists.
 */
export async function seedSuperadmin(login = env.SUPERADMIN_LOGIN, password = env.SUPERADMIN_PASSWORD) {
  if (!login || !password) {
    throw new Error('Set SUPERADMIN_LOGIN and SUPERADMIN_PASSWORD (min 8 chars) to seed the superadmin.');
  }
  if (password.length < 8) throw new Error('SUPERADMIN_PASSWORD must have at least 8 characters.');
  const existing = await User.findOne({ login: login.toLowerCase() }).setOptions({ crossTenant: true });
  if (existing) return { created: false, id: String(existing._id) };
  const user = await User.create({
    role: 'superadmin',
    shopId: null,
    fullName: env.SUPERADMIN_FULL_NAME,
    login,
    passwordHash: await hashSecret(password),
    language: 'en',
  });
  return { created: true, id: String(user._id) };
}

if (require.main === module && /seed-superadmin\.(ts|js)$/.test(process.argv[1] ?? '')) {
  (async () => {
    await connectDb();
    await User.init();
    const r = await seedSuperadmin();
    console.log(r.created ? `Superadmin created (id ${r.id}).` : 'Superadmin already exists - nothing to do.');
    await disconnectDb();
  })().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
