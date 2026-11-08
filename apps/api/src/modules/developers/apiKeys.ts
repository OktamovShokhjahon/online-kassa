import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { isoDate, objectId } from '@kass/shared';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { forbidden, notFound, tooMany, unauthorized } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import * as limiter from '../../lib/rateLimit';
import { assertShopUsable, authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch, Shop } from '../../models/core';
import { API_SCOPES, ApiKey, type ApiScope } from '../../models/integrations';

export const RATE_LIMIT_PER_MIN = 120;

/* ============================================================== key management (JWT) */

export const apiKeysRouter = Router();
apiKeysRouter.use(authenticate, requirePermission('developers.manage'));

apiKeysRouter.get(
  '/',
  h(async (req, res) => {
    const keys = await repo(req, ApiKey).find({}, { sort: '-createdAt' });
    ok(res, keys.map((k) => ({ ...k.toJSON(), display: `${k.prefix}…${k.last4}`, active: !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date()) })));
  }),
);

/** The full key is returned ONCE; afterwards only its prefix and last 4 characters are visible. */
apiKeysRouter.post(
  '/',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(80),
      scopes: z.array(z.enum(API_SCOPES)).min(1),
      branchId: objectId.optional(),
      expiresAt: isoDate.optional(),
    }),
  }),
  h(async (req, res) => {
    const a = auth(req);
    if (req.body.branchId && !(await repo(req, Branch).exists({ _id: req.body.branchId }))) throw notFound('BRANCH_NOT_FOUND');
    if (req.body.expiresAt && req.body.expiresAt <= new Date()) throw notFound();
    const secret = `kk_live_${randomToken(32)}`;
    const key = await repo(req, ApiKey).create({
      name: req.body.name,
      scopes: [...new Set(req.body.scopes)],
      branchId: req.body.branchId ?? null,
      expiresAt: req.body.expiresAt,
      prefix: secret.slice(0, 12),
      last4: secret.slice(-4),
      keyHash: sha256(secret),
      createdBy: a.userId,
    });
    await audit(req, { action: 'api_key.created', entity: 'api_key', entityId: key._id, meta: { name: key.name, scopes: key.scopes } });
    created(res, { ...key.toJSON(), key: secret });
  }),
);

apiKeysRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }) }),
  h(async (req, res) => {
    const key = await repo(req, ApiKey).findOneAndUpdate({ _id: req.params.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    if (!key) throw notFound();
    await audit(req, { action: 'api_key.revoked', entity: 'api_key', entityId: key._id });
    ok(res, key.toJSON());
  }),
);

/* ========================================================= authentication (API key) */

/** Bearer API key -> tenant context, scope list and per-key rate limit (spec 10.2). */
export const authenticateApiKey: RequestHandler = h(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized('API_KEY_INVALID');
  const key = await ApiKey.findOne({ keyHash: sha256(header.slice(7)) }).setOptions({ crossTenant: true });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) throw unauthorized('API_KEY_INVALID');
  const shop = await Shop.findById(key.shopId);
  await assertShopUsable(shop); // blocked/expired shops lose API access at once

  const { count, resetAt } = await limiter.hit(`apikey:${key._id}`, 60_000);
  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_PER_MIN);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_PER_MIN - count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt.getTime() / 1000));
  if (count > RATE_LIMIT_PER_MIN) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)));
    throw tooMany('RATE_LIMITED');
  }
  void ApiKey.updateOne({ _id: key._id, shopId: key.shopId }, { $inc: { requestCount: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => undefined);
  const program = key.program?.kind ? { kind: key.program.kind as 'desk', terminalId: key.program.terminalId, cashierId: key.program.cashierId } : null;
  req.apiKey = { kind: 'apiKey', keyId: key._id, shopId: key.shopId, scopes: new Set(key.scopes), branchId: key.branchId ?? null, shop: shop!, program };
  next();
});

export const requireScope = (scope: ApiScope): RequestHandler => (req, _res, next) => {
  if (!req.apiKey?.scopes.has(scope)) return next(forbidden('SCOPE_MISSING'));
  next();
};
