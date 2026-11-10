import { Router } from 'express';
import { z } from 'zod';
import {
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_GRANTABLE_PERMISSIONS,
  objectId,
  staffCreateSchema,
  staffListQuerySchema,
  staffResetPasswordSchema,
  staffStatusSchema,
  staffUpdateSchema,
  userCredentialsSchema,
  type Permission,
  type Role,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { generatePassword } from '../../lib/crypto';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import { revokeUserSessions } from '../../lib/tokens';
import { escapeRegex, oid, parseSort } from '../../lib/util';
import { authenticate, can, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch, User, type UserDoc } from '../../models/core';
import { hashSecret, publicUser, sealPassword } from '../auth/service';
import { applyCredentials, withCredentials } from './credentials';
import type { AuthContext } from '../../types';

export const staffRouter = Router();
staffRouter.use(authenticate, requirePermission('staff.manage', 'staff.cashiers'));

const idParams = validate({ params: z.object({ id: objectId }) });

/** What the caller may manage: the admin everything; a branch manager only cashiers of own branches. */
function assertCanManage(a: AuthContext, target: { role: string; branchIds?: unknown[] }) {
  if (a.role === 'shop_admin') return;
  const sameBranch = (target.branchIds ?? []).some((b) => a.branchIds.some((x) => String(x) === String(b)));
  if (target.role !== 'cashier' || !sameBranch) throw forbidden();
}

async function assertBranchesBelongToShop(req: Parameters<typeof repo>[0], branchIds: string[]) {
  if (!branchIds.length) return;
  const n = await repo(req, Branch).count({ _id: { $in: branchIds } });
  if (n !== new Set(branchIds).size) throw notFound('BRANCH_NOT_FOUND');
}

/** Stores only the extras beyond role defaults and checks they are grantable to the role. */
function extraPermissions(role: Role, requested: Permission[], actor: AuthContext): Permission[] {
  const defaults = new Set<string>(ROLE_DEFAULT_PERMISSIONS[role]);
  const grantable = new Set<string>(ROLE_GRANTABLE_PERMISSIONS[role]);
  const extras = [...new Set(requested)].filter((p) => !defaults.has(p));
  for (const p of extras) {
    if (!grantable.has(p)) throw unprocessable('PERMISSION_NOT_GRANTABLE', undefined, { permission: p });
    // A manager cannot hand out rights they do not hold themselves.
    if (actor.role !== 'shop_admin' && !can(actor, p)) throw forbidden();
  }
  return extras;
}

async function checkEmployeeLimit(req: Parameters<typeof repo>[0], a: AuthContext, adding = 1) {
  const staff = await repo(req, User).count({ isActive: true, role: { $ne: 'shop_admin' } });
  if (staff + adding > a.shop!.limits!.maxEmployees) throw unprocessable('LIMIT_REACHED');
}

staffRouter.get(
  '/',
  validate({ query: staffListQuerySchema }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as unknown as z.infer<typeof staffListQuerySchema>;
    const filter: Record<string, any> = {};
    if (a.role !== 'shop_admin') {
      filter.role = 'cashier';
      filter.branchIds = { $in: a.branchIds };
    } else if (q.role) filter.role = q.role;
    if (q.branchId) filter.branchIds = oid(q.branchId);
    if (q.active) filter.isActive = q.active === 'true';
    if (q.q) {
      const rx = new RegExp(escapeRegex(q.q), 'i');
      filter.$or = [{ fullName: rx }, { login: rx }, { phone: rx }];
    }
    const { items, meta } = await repo(req, User).paginate(filter, { page: q.page, limit: q.limit, sort: parseSort(q.sort, ['fullName', 'login', 'role', 'createdAt'], 'fullName') });
    // isActive is needed by the staff table (status badge, activate / deactivate button)
    ok(res, items.map((u) => ({ ...publicUser(u as UserDoc), isActive: (u as UserDoc).isActive, lastLoginAt: (u as any).lastLoginAt ?? null })), meta);
  }),
);

/** The shop owner sees the login and password of every employee (not of other owners). */
staffRouter.get(
  '/credentials',
  h(async (req, res) => {
    const a = auth(req);
    if (a.role !== 'shop_admin') throw forbidden();
    const users = await repo(req, User).find({ role: { $ne: 'shop_admin' } });
    users.sort((x: any, y: any) => Number(y.isActive) - Number(x.isActive) || String(x.fullName).localeCompare(String(y.fullName)));
    await audit(req, { action: 'staff.credentials_viewed', entity: 'user' });
    ok(res, users.map((u: any) => withCredentials(u)));
  }),
);

staffRouter.get(
  '/:id',
  idParams,
  h(async (req, res) => {
    const a = auth(req);
    const u = await repo(req, User).findById(req.params.id);
    if (!u) throw notFound('USER_NOT_FOUND');
    if (u.role !== 'shop_admin') assertCanManage(a, u);
    ok(res, publicUser(u));
  }),
);

/** The shop owner changes an employee's login, password or name. */
staffRouter.patch(
  '/:id/credentials',
  idParams,
  validate({ body: userCredentialsSchema }),
  h(async (req, res) => {
    const a = auth(req);
    if (a.role !== 'shop_admin') throw forbidden();
    const u = await repo(req, User).findById(req.params.id);
    if (!u) throw notFound('USER_NOT_FOUND');
    if (u.role === 'shop_admin') throw forbidden('CANNOT_MODIFY_ADMIN');
    const r = await applyCredentials(u as any, req.body);
    await audit(req, { action: 'staff.credentials_changed', entity: 'user', entityId: u._id, meta: r });
    ok(res, withCredentials(u as any));
  }),
);

staffRouter.post(
  '/',
  validate({ body: staffCreateSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof staffCreateSchema>;
    const role = b.role as Role;
    if (a.role !== 'shop_admin') {
      // branch managers: cashiers only, inside their own branches
      if (role !== 'cashier' || !can(a, 'staff.cashiers')) throw forbidden();
      if (!b.branchIds.length || !b.branchIds.every((id) => a.branchIds.some((x) => String(x) === id))) throw forbidden();
    }
    if (!b.branchIds.length) throw badRequest('BRANCH_NOT_FOUND');
    await assertBranchesBelongToShop(req, b.branchIds);
    await checkEmployeeLimit(req, a);

    const login = b.login.toLowerCase();
    if (await User.exists({ login }).setOptions({ crossTenant: true })) throw conflict('LOGIN_TAKEN');
    const user = await repo(req, User).create({
      role,
      fullName: b.fullName,
      phone: b.phone,
      login,
      passwordHash: await hashSecret(b.password),
      passwordEnc: sealPassword(b.password),
      pinHash: b.pin ? await hashSecret(b.pin) : undefined,
      branchIds: b.branchIds.map(oid),
      permissions: extraPermissions(role, b.permissions as Permission[], a),
      language: b.language,
    });
    await audit(req, { action: 'staff.created', entity: 'user', entityId: user._id, after: user });
    created(res, publicUser(user));
  }),
);

staffRouter.patch(
  '/:id',
  idParams,
  validate({ body: staffUpdateSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof staffUpdateSchema>;
    const u = await repo(req, User).findById(req.params.id);
    if (!u) throw notFound('USER_NOT_FOUND');
    if (u.role === 'shop_admin') throw forbidden('CANNOT_MODIFY_ADMIN');
    assertCanManage(a, u);
    const before = u.toObject();

    if (b.branchIds) {
      if (!b.branchIds.length) throw badRequest('BRANCH_NOT_FOUND');
      if (a.role !== 'shop_admin' && !b.branchIds.every((id) => a.branchIds.some((x) => String(x) === id))) throw forbidden();
      await assertBranchesBelongToShop(req, b.branchIds);
      u.branchIds = b.branchIds.map(oid) as any;
    }
    if (b.permissions) u.permissions = extraPermissions(u.role as Role, b.permissions as Permission[], a);
    if (b.fullName !== undefined) u.fullName = b.fullName;
    if (b.phone !== undefined) u.phone = b.phone;
    if (b.language !== undefined) u.language = b.language;
    if (b.pin !== undefined) u.pinHash = b.pin ? await hashSecret(b.pin) : undefined;
    // New branches/permissions take effect immediately: old access tokens must be refreshed.
    u.permVersion += 1;
    await u.save();
    await audit(req, { action: 'staff.updated', entity: 'user', entityId: u._id, before, after: u });
    ok(res, publicUser(u));
  }),
);

staffRouter.post(
  '/:id/reset-password',
  idParams,
  validate({ body: staffResetPasswordSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const u = await repo(req, User).findById(req.params.id);
    if (!u) throw notFound('USER_NOT_FOUND');
    if (u.role === 'shop_admin') throw forbidden('CANNOT_MODIFY_ADMIN');
    assertCanManage(a, u);
    const newPassword = req.body.newPassword ?? generatePassword();
    u.passwordHash = await hashSecret(newPassword);
    u.passwordEnc = sealPassword(newPassword);
    u.permVersion += 1;
    await u.save();
    await revokeUserSessions(u._id);
    await audit(req, { action: 'staff.password_reset', entity: 'user', entityId: u._id });
    ok(res, { login: u.login, newPassword }); // shown once
  }),
);

staffRouter.patch(
  '/:id/status',
  idParams,
  validate({ body: staffStatusSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const u = await repo(req, User).findById(req.params.id);
    if (!u) throw notFound('USER_NOT_FOUND');
    if (u.role === 'shop_admin') throw forbidden('CANNOT_MODIFY_ADMIN');
    assertCanManage(a, u);
    if (req.body.isActive && !u.isActive) await checkEmployeeLimit(req, a);
    u.isActive = req.body.isActive;
    u.permVersion += 1;
    await u.save();
    // A deactivated employee cannot log in; history (sales, shifts) stays in reports.
    if (!u.isActive) await revokeUserSessions(u._id);
    await audit(req, { action: u.isActive ? 'staff.activated' : 'staff.deactivated', entity: 'user', entityId: u._id });
    ok(res, publicUser(u));
  }),
);
