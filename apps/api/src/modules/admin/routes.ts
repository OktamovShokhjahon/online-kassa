import { Router } from 'express';
import { z } from 'zod';
import {
  addDays,
  tashkentDateString,
  tashkentDayRange,
  auditQuerySchema,
  blockShopSchema,
  changeShopAdminSchema,
  createShopSchema,
  fiscalSettingsSchema,
  objectId,
  paginationSchema,
  platformSettingsSchema,
  recordPaymentSchema,
  resetPasswordSchema,
  shopListQuerySchema,
  updateShopSchema,
  userCredentialsSchema,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { generatePassword } from '../../lib/crypto';
import { withTx } from '../../db/connect';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok } from '../../lib/http';
import {
  effectiveStatus,
  getGraceDays,
  getPlatformSettings,
  nextShopCode,
  invalidatePlatformCache,
  statusFilter,
} from '../../lib/platform';
import {
  createSession,
  revokeShopSessions,
  revokeUserSessions,
  signAccessToken,
} from '../../lib/tokens';
import { escapeRegex, isObjectId, oid, parseSort } from '../../lib/util';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import {
  AuditLog,
  Branch,
  Shop,
  ShopPayment,
  Terminal,
  User,
  type ShopDoc,
} from '../../models/core';
import { hashSecret, publicShop, publicUser, sealPassword } from '../auth/service';
import { applyCredentials, withCredentials } from '../shop/credentials';
import { platformSalesStats, shopStats } from './stats';
import { clearExpiryFlag } from '../../workers/shopExpiry';
import { agentHub } from '../agent/hub';
import { encrypt } from '../../lib/crypto';
import { fiscalProviderNames } from '../../lib/fiscal/service';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('superadmin'));

const idParams = validate({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) }) });
const ONLINE_WINDOW_MS = 90_000;

async function findShop(id: string): Promise<ShopDoc> {
  const shop = await Shop.findById(id);
  if (!shop) throw notFound();
  return shop as ShopDoc;
}

/** Platform-level audit entry about a shop (visible to the superadmin only). */
const platformAudit = (req: Parameters<typeof audit>[0], action: string, shopId: unknown, extra: Record<string, unknown> = {}) =>
  audit(req, { action, entity: 'shop', entityId: String(shopId), shopId: null, ...extra });

/* ----------------------------------------------------------------------- dashboard */

adminRouter.get(
  '/dashboard',
  h(async (_req, res) => {
    const now = new Date();
    const grace = await getGraceDays();
    const soon = addDays(now, 7);
    const [total, active, trial, blocked, expired, expiring, onlineTerminals, totalTerminals] = await Promise.all([
      Shop.countDocuments({}),
      Shop.countDocuments(statusFilter('active', grace, now)),
      Shop.countDocuments(statusFilter('trial', grace, now)),
      Shop.countDocuments(statusFilter('blocked', grace, now)),
      Shop.countDocuments(statusFilter('expired', grace, now)),
      Shop.countDocuments({ status: 'active', paidUntil: { $ne: null, $gte: now, $lte: soon } }),
      Terminal.countDocuments({ lastSeenAt: { $gte: new Date(now.getTime() - ONLINE_WINDOW_MS) } }).setOptions({ crossTenant: true }),
      Terminal.countDocuments({}).setOptions({ crossTenant: true }),
    ]);

    const attention = await Shop.find({
      status: 'active',
      paidUntil: { $ne: null, $lte: soon },
    })
      .sort({ paidUntil: 1 })
      .limit(10);

    ok(res, {
      shops: { total, active, trial, blocked, expired, expiringIn7Days: expiring },
      terminals: { total: totalTerminals, online: onlineTerminals },
      sales: await platformSalesStats(now),
      attention: attention.map((s) => ({
        id: String(s._id),
        name: s.name,
        paidUntil: s.paidUntil,
        status: effectiveStatus(s as ShopDoc, grace, now).status,
      })),
    });
  }),
);

/* ---------------------------------------------------------------------- shops list */

adminRouter.get(
  '/shops',
  validate({ query: shopListQuerySchema }),
  h(async (req, res) => {
    const { page, limit, sort, q, status, fiscal } = req.query as unknown as z.infer<typeof shopListQuerySchema>;
    const grace = await getGraceDays();
    const filter: Record<string, any> = {};
    if (status) Object.assign(filter, statusFilter(status, grace));
    if (fiscal) filter.fiscalEnabled = fiscal === 'on';
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const admins = await User.find({ role: 'shop_admin', $or: [{ login: rx }, { fullName: rx }, { phone: rx }] })
        .setOptions({ crossTenant: true })
        .select('shopId')
        .lean();
      filter.$or = [{ name: rx }, { _id: { $in: admins.map((a) => a.shopId) } }];
    }
    const [items, total] = await Promise.all([
      Shop.find(filter)
        .sort(parseSort(sort, ['name', 'paidUntil', 'createdAt']))
        .skip((page - 1) * limit)
        .limit(limit),
      Shop.countDocuments(filter),
    ]);

    const ids = items.map((s) => s._id);
    const [admins, branchCounts, terminalCounts, lastLogins] = await Promise.all([
      User.find({ shopId: { $in: ids }, role: 'shop_admin', isActive: true }).setOptions({ crossTenant: true }).lean(),
      Branch.aggregate([{ $match: { shopId: { $in: ids } } }, { $group: { _id: '$shopId', n: { $sum: 1 } } }]),
      Terminal.aggregate([{ $match: { shopId: { $in: ids } } }, { $group: { _id: '$shopId', n: { $sum: 1 } } }]),
      User.aggregate([
        { $match: { shopId: { $in: ids } } },
        { $group: { _id: '$shopId', last: { $max: '$lastLoginAt' } } },
      ]),
    ]);
    const by = (rows: any[], f: (r: any) => unknown) => new Map(rows.map((r) => [String(r._id), f(r)]));
    const bc = by(branchCounts, (r) => r.n);
    const tc = by(terminalCounts, (r) => r.n);
    const ll = by(lastLogins, (r) => r.last);

    ok(
      res,
      items.map((s) => {
        const admin = admins.find((a) => String(a.shopId) === String(s._id));
        return {
          ...s.toJSON(),
          effectiveStatus: effectiveStatus(s as ShopDoc, grace).status,
          admin: admin ? { id: String(admin._id), fullName: admin.fullName, phone: admin.phone, login: admin.login } : null,
          branchCount: bc.get(String(s._id)) ?? 0,
          terminalCount: tc.get(String(s._id)) ?? 0,
          lastActivityAt: ll.get(String(s._id)) ?? null,
        };
      }),
      { page, limit, total },
    );
  }),
);

/* --------------------------------------------------------------------- create shop */

adminRouter.post(
  '/shops',
  validate({ body: createShopSchema }),
  h(async (req, res) => {
    const input = req.body as z.infer<typeof createShopSchema>;
    const login = input.adminLogin.toLowerCase();
    if (await User.exists({ login }).setOptions({ crossTenant: true })) throw conflict('LOGIN_TAKEN');

    const settings = await getPlatformSettings();
    const limits = {
      maxBranches: input.limits?.maxBranches ?? settings.defaultLimits!.maxBranches,
      maxTerminals: input.limits?.maxTerminals ?? settings.defaultLimits!.maxTerminals,
      maxEmployees: input.limits?.maxEmployees ?? settings.defaultLimits!.maxEmployees,
    };
    const passwordHash = await hashSecret(input.adminPassword);
    const shopCode = await nextShopCode();

    // Shop + first branch + admin user succeed or fail together.
    const { shop, branch, admin } = await withTx(async (session) => {
      const [shop] = await Shop.create(
        [
          {
            name: input.name,
            shopCode,
            address: input.address,
            tin: input.tin,
            currency: input.currency,
            fiscalEnabled: input.fiscalEnabled,
            paidUntil: input.paidUntil ?? null,
            limits,
            note: input.note,
            settings: { receiptLanguage: input.adminLanguage },
          },
        ],
        { session },
      );
      const [branch] = await Branch.create(
        [{ shopId: shop._id, name: input.firstBranchName, address: input.address }],
        { session },
      );
      const [admin] = await User.create(
        [
          {
            role: 'shop_admin',
            shopId: shop._id,
            fullName: input.adminFullName,
            phone: input.adminPhone,
            login,
            passwordHash,
            passwordEnc: sealPassword(input.adminPassword),
            branchIds: [branch._id],
            language: input.adminLanguage,
          },
        ],
        { session },
      );
      await audit(req, { action: 'shop.created', entity: 'shop', entityId: shop._id, shopId: null, after: shop }, session);
      return { shop, branch, admin };
    });

    created(res, {
      shop: await publicShop(shop as ShopDoc),
      branch: branch.toJSON(),
      admin: publicUser(admin),
    });
  }),
);

/* ------------------------------------------------------------------ shop details */

adminRouter.get(
  '/shops/:id',
  idParams,
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const grace = await getGraceDays();
    const [admin, branches, terminals, payments, employeeCount] = await Promise.all([
      User.findOne({ shopId: shop._id, role: 'shop_admin', isActive: true }).setOptions({ crossTenant: true }),
      Branch.find({ shopId: shop._id }),
      Terminal.find({ shopId: shop._id }),
      ShopPayment.find({ shopId: shop._id }).sort('-paidAt').limit(50),
      User.countDocuments({ shopId: shop._id, role: { $ne: 'shop_admin' }, isActive: true }),
    ]);
    const st = effectiveStatus(shop, grace);
    ok(res, {
      ...shop.toJSON(),
      effectiveStatus: st.status,
      inGrace: st.inGrace,
      graceDaysLeft: st.graceDaysLeft,
      admin: admin ? publicUser(admin) : null,
      branches: branches.map((b) => b.toJSON()),
      terminals: terminals.map((t) => ({
        ...t.toJSON(),
        online: !!t.lastSeenAt && Date.now() - new Date(t.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
      })),
      payments: payments.map((p) => p.toJSON()),
      employeeCount,
    });
  }),
);

adminRouter.patch(
  '/shops/:id',
  idParams,
  validate({ body: updateShopSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const before = shop.toObject();
    const body = req.body as z.infer<typeof updateShopSchema>;
    if (body.name !== undefined) shop.name = body.name;
    if (body.address !== undefined) shop.address = body.address;
    if (body.tin !== undefined) shop.tin = body.tin ?? undefined;
    if (body.note !== undefined) shop.note = body.note;
    if (body.paidUntil !== undefined) shop.paidUntil = body.paidUntil as Date | null;
    if (body.limits) Object.assign(shop.limits!, body.limits);
    if (shop.fiscalEnabled && !shop.tin) throw badRequest('TIN_REQUIRED');
    await shop.save();
    if (body.paidUntil !== undefined) await clearExpiryFlag(shop._id);
    await platformAudit(req, 'shop.updated', shop._id, { before, after: shop });
    ok(res, shop.toJSON());
  }),
);

/* ------------------------------------------------------------- block / unblock */

adminRouter.post(
  '/shops/:id/block',
  idParams,
  validate({ body: blockShopSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    if (shop.status === 'blocked') throw unprocessable('SHOP_ALREADY_BLOCKED');
    shop.status = 'blocked';
    shop.blockReason = req.body.reason;
    shop.blockedAt = new Date();
    await shop.save();
    // Blocking revokes sessions and agent tokens at once; API keys are rejected by the tenant check.
    await revokeShopSessions(shop._id);
    await Terminal.updateMany({ shopId: shop._id }, { $unset: { agentTokenHash: '', pairingCodeHash: '' } });
    agentHub.disconnectShop(String(shop._id));
    await platformAudit(req, 'shop.blocked', shop._id, { meta: { reason: req.body.reason } });
    ok(res, shop.toJSON());
  }),
);

adminRouter.post(
  '/shops/:id/unblock',
  idParams,
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    if (shop.status !== 'blocked') throw unprocessable('SHOP_NOT_BLOCKED');
    shop.status = 'active';
    shop.blockReason = undefined;
    shop.blockedAt = undefined;
    await shop.save();
    await platformAudit(req, 'shop.unblocked', shop._id);
    ok(res, shop.toJSON());
  }),
);

/* ---------------------------------------------------------------- admin accounts */

adminRouter.post(
  '/shops/:id/reset-admin-password',
  idParams,
  validate({ body: resetPasswordSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const admin = await User.findOne({ shopId: shop._id, role: 'shop_admin', isActive: true });
    if (!admin) throw notFound();
    const newPassword: string = req.body.newPassword ?? generatePassword();
    admin.passwordHash = await hashSecret(newPassword);
    admin.passwordEnc = sealPassword(newPassword);
    admin.permVersion += 1;
    await admin.save();
    await revokeUserSessions(admin._id);
    await platformAudit(req, 'shop.admin_password_reset', shop._id);
    // Shown once; never stored in plain text or logged.
    ok(res, { login: admin.login, newPassword });
  }),
);

adminRouter.post(
  '/shops/:id/change-admin',
  idParams,
  validate({ body: changeShopAdminSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const b = req.body as z.infer<typeof changeShopAdminSchema>;
    const login = b.login.toLowerCase();
    if (await User.exists({ login }).setOptions({ crossTenant: true })) throw conflict('LOGIN_TAKEN');
    const passwordHash = await hashSecret(b.password);
    const branches = await Branch.find({ shopId: shop._id }).select('_id');

    const admin = await withTx(async (session) => {
      const old = await User.find({ shopId: shop._id, role: 'shop_admin', isActive: true }).session(session);
      for (const o of old) {
        o.isActive = false;
        o.permVersion += 1;
        await o.save({ session });
        await revokeUserSessions(o._id);
      }
      const [admin] = await User.create(
        [
          {
            role: 'shop_admin',
            shopId: shop._id,
            fullName: b.fullName,
            phone: b.phone,
            login,
            passwordHash,
            passwordEnc: sealPassword(b.password),
            branchIds: branches.map((x) => x._id),
            language: b.language,
          },
        ],
        { session },
      );
      return admin;
    });
    await platformAudit(req, 'shop.admin_changed', shop._id, { after: { login } });
    created(res, publicUser(admin));
  }),
);

/** Statistics of one shop for the platform owner (the Statistics tab of the shop page). */
adminRouter.get(
  '/shops/:id/stats',
  validate({ params: z.object({ id: objectId }), query: z.object({ period: z.enum(['today', '7d', '30d', 'month', 'all']).default('30d') }) }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const period = (req.query as any).period as 'today' | '7d' | '30d' | 'month' | 'all';
    const now = new Date();
    const todayStr = tashkentDateString(now);
    const to = tashkentDayRange(todayStr).to;
    const startOf = (d: string) => tashkentDayRange(d).from;
    const back = (n: number) => startOf(tashkentDateString(new Date(now.getTime() - n * 86_400_000)));
    const from = period === 'today' ? startOf(todayStr) : period === '7d' ? back(6) : period === '30d' ? back(29) : period === 'month' ? startOf(todayStr.slice(0, 8) + '01') : undefined;
    ok(res, { period, from: from ?? null, to, currency: shop.currency, ...(await shopStats(shop._id, from, to)) });
  }),
);

/* ------------------------------------------------- users of a shop: logins and passwords */

/** Every account of the shop (owner and staff) with login and password, for the platform owner. */
adminRouter.get(
  '/shops/:id/users',
  idParams,
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const users = await User.find({ shopId: shop._id }).sort({ role: 1, isActive: -1, fullName: 1 });
    await platformAudit(req, 'shop.credentials_viewed', shop._id);
    ok(res, users.map(withCredentials));
  }),
);

adminRouter.patch(
  '/shops/:id/users/:userId',
  validate({ params: z.object({ id: objectId, userId: objectId }), body: userCredentialsSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const u = await User.findOne({ _id: req.params.userId, shopId: shop._id });
    if (!u) throw notFound('USER_NOT_FOUND');
    const r = await applyCredentials(u, req.body);
    await platformAudit(req, 'shop.user_credentials_changed', shop._id, { after: { userId: String(u._id), login: u.login, ...r } });
    ok(res, withCredentials(u));
  }),
);

/* ------------------------------------------------------------------------- fiscal */

adminRouter.patch(
  '/shops/:id/fiscal',
  idParams,
  validate({ body: fiscalSettingsSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const before = { fiscalEnabled: shop.fiscalEnabled, tin: shop.tin };
    if (req.body.tin) shop.tin = req.body.tin;
    if (req.body.fiscalEnabled && !shop.tin) throw badRequest('TIN_REQUIRED');
    shop.fiscalEnabled = req.body.fiscalEnabled;
    await shop.save();
    // Switching Off never deletes the fiscal data of earlier receipts.
    await platformAudit(req, 'shop.fiscal_changed', shop._id, { before, after: { fiscalEnabled: shop.fiscalEnabled, tin: shop.tin } });
    ok(res, { fiscalEnabled: shop.fiscalEnabled, tin: shop.tin });
  }),
);

/** Per-terminal fiscal module settings (spec 4.4): provider, module id and encrypted credentials. */
adminRouter.put(
  '/shops/:id/terminals/:terminalId/fiscal',
  validate({
    params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i), terminalId: z.string().regex(/^[a-f\d]{24}$/i) }),
    body: z.object({ provider: z.string().min(1).max(40), moduleId: z.string().max(100).optional(), credentials: z.record(z.unknown()).default({}) }),
  }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    if (!fiscalProviderNames().includes(req.body.provider)) throw badRequest('VALIDATION_ERROR', [{ path: 'provider', message: 'Unknown provider. Available: ' + fiscalProviderNames().join(', ') }]);
    const terminal = await Terminal.findOne({ _id: req.params.terminalId, shopId: shop._id });
    if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
    terminal.fiscal = { provider: req.body.provider, moduleId: req.body.moduleId, credentialsEncrypted: encrypt(JSON.stringify(req.body.credentials)) } as any;
    await terminal.save();
    await platformAudit(req, 'shop.terminal_fiscal_changed', shop._id, { meta: { terminalId: String(terminal._id), provider: req.body.provider, moduleId: req.body.moduleId } });
    ok(res, { terminalId: String(terminal._id), provider: req.body.provider, moduleId: req.body.moduleId, hasCredentials: true });
  }),
);

adminRouter.get('/fiscal-providers', h(async (_req, res) => ok(res, fiscalProviderNames())));

/* ---------------------------------------------------------------------- payments */

adminRouter.get(
  '/shops/:id/payments',
  idParams,
  validate({ query: paginationSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    const filter = { shopId: shop._id };
    const [items, total] = await Promise.all([
      ShopPayment.find(filter).sort('-paidAt').skip((page - 1) * limit).limit(limit),
      ShopPayment.countDocuments(filter),
    ]);
    ok(res, items.map((p) => p.toJSON()), { page, limit, total });
  }),
);

/** Recording a payment extends "paid until" to the end of the covered period. */
adminRouter.post(
  '/shops/:id/payments',
  idParams,
  validate({ body: recordPaymentSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const b = req.body as z.infer<typeof recordPaymentSchema>;
    const before = shop.paidUntil;
    const payment = await ShopPayment.create({ ...b, shopId: shop._id, createdBy: auth(req).userId });
    if (!shop.paidUntil || b.periodTo > shop.paidUntil) shop.paidUntil = b.periodTo;
    await shop.save();
    await clearExpiryFlag(shop._id);
    await platformAudit(req, 'shop.payment_recorded', shop._id, {
      before: { paidUntil: before },
      after: { paidUntil: shop.paidUntil, amount: b.amount, currency: b.currency },
    });
    created(res, { payment: payment.toJSON(), paidUntil: shop.paidUntil });
  }),
);

/* ------------------------------------------------------------------ impersonation */

/** Audited "log in as shop admin". The token is short-lived and carries the `imp` claim. */
adminRouter.post(
  '/shops/:id/impersonate',
  idParams,
  validate({ body: z.object({ confirm: z.literal(true) }) }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const st = effectiveStatus(shop, await getGraceDays());
    if (st.status === 'blocked') throw forbidden('SHOP_BLOCKED');
    if (st.status === 'expired') throw forbidden('SHOP_EXPIRED');
    const admin = await User.findOne({ shopId: shop._id, role: 'shop_admin', isActive: true });
    if (!admin) throw notFound();

    const a = auth(req);
    const { session } = await createSession(admin, req, { impersonatedBy: a.userId, ttlDays: 1 });
    const accessToken = signAccessToken(admin, {
      sessionId: String(session._id),
      impersonatedBy: String(a.userId),
      ttlSeconds: 60 * 60,
    });
    await platformAudit(req, 'shop.impersonated', shop._id, { meta: { asUser: String(admin._id) } });
    await audit(req, { action: 'support.impersonation_started', entity: 'user', entityId: admin._id, shopId: shop._id });
    ok(res, { accessToken, expiresIn: 3600, user: publicUser(admin), shop: await publicShop(shop), home: '/shop' });
  }),
);

/* ---------------------------------------------------------------- audit & settings */

adminRouter.get(
  '/audit-logs',
  validate({ query: auditQuerySchema }),
  h(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof auditQuerySchema>;
    // Platform log: entries with shopId = null; a shop's own log is read via GET /audit-logs.
    const filter: Record<string, any> = { shopId: f.shopId && isObjectId(f.shopId) ? oid(f.shopId) : null };
    if (f.action) filter.action = f.action;
    if (f.entity) filter.entity = f.entity;
    if (f.userId) filter.userId = oid(f.userId);
    if (f.from || f.to) filter.createdAt = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) };
    if (f.entityId) filter.entityId = f.entityId;
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort('-createdAt').skip((f.page - 1) * f.limit).limit(f.limit),
      AuditLog.countDocuments(filter),
    ]);
    ok(res, items.map((i) => i.toJSON()), { page: f.page, limit: f.limit, total });
  }),
);

adminRouter.get(
  '/settings',
  h(async (_req, res) => {
    ok(res, (await getPlatformSettings()).toJSON());
  }),
);

adminRouter.patch(
  '/settings',
  validate({ body: platformSettingsSchema }),
  h(async (req, res) => {
    const b = req.body as z.infer<typeof platformSettingsSchema>;
    const current = await getPlatformSettings();
    const before = current.toObject();
    if (b.defaultLimits) Object.assign(current.defaultLimits!, b.defaultLimits);
    if (b.graceDays !== undefined) current.graceDays = b.graceDays;
    if (b.platformName !== undefined) current.platformName = b.platformName;
    if (b.logoUrl !== undefined) current.logoUrl = b.logoUrl;
    if (b.longShiftHours !== undefined) current.longShiftHours = b.longShiftHours;
    if (b.agentInstaller) Object.assign(current.agentInstaller!, b.agentInstaller);
    await current.save();
    invalidatePlatformCache();
    await audit(req, { action: 'platform.settings_changed', entity: 'settings', shopId: null, before, after: current });
    ok(res, current.toJSON());
  }),
);

