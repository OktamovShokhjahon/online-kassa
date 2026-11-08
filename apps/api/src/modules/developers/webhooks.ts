import dns from 'node:dns/promises';
import net from 'node:net';
import { Router } from 'express';
import { z } from 'zod';
import { objectId, paginationSchema } from '@kass/shared';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { decrypt, encrypt, hmacSha256, randomToken } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { events, type DomainEvent } from '../../lib/events';
import { auth, created, h, ok, repo } from '../../lib/http';
import { logger } from '../../lib/logger';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { WEBHOOK_EVENTS, Webhook, WebhookDelivery } from '../../models/integrations';

/* ------------------------------------------------------------------ URL safety (SSRF) */

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

const allowPrivate = () => process.env.ALLOW_PRIVATE_WEBHOOKS === 'true';

/**
 * Webhook URLs come from shop admins and are called by OUR server, so they must never reach the
 * internal network (cloud metadata, databases, localhost). Checked on save and again right before
 * every delivery (DNS rebinding).
 */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('WEBHOOK_URL_INVALID');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowPrivate() || !env.isProd))) throw badRequest('WEBHOOK_URL_INVALID');
  if (url.username || url.password) throw badRequest('WEBHOOK_URL_INVALID');
  if (!allowPrivate()) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw badRequest('WEBHOOK_URL_INVALID');
  }
  return url;
}

/* ------------------------------------------------------------------------ management */

export const webhooksRouter = Router();
webhooksRouter.use(authenticate, requirePermission('developers.manage'));
const idParams = validate({ params: z.object({ id: objectId }) });
const eventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1);

webhooksRouter.get(
  '/',
  h(async (req, res) => {
    const list = await repo(req, Webhook).find({}, { sort: '-createdAt' });
    ok(res, list.map((w) => w.toJSON()));
  }),
);

/** The signing secret is shown once, on creation. */
webhooksRouter.post(
  '/',
  validate({ body: z.object({ url: z.string().url().max(500), events: eventsSchema, description: z.string().max(200).optional() }) }),
  h(async (req, res) => {
    await assertSafeWebhookUrl(req.body.url);
    const secret = `whsec_${randomToken(24)}`;
    const w = await repo(req, Webhook).create({ ...req.body, secretEncrypted: encrypt(secret), createdBy: auth(req).userId });
    await audit(req, { action: 'webhook.created', entity: 'webhook', entityId: w._id, meta: { url: w.url, events: w.events } });
    created(res, { ...w.toJSON(), secret });
  }),
);

webhooksRouter.patch(
  '/:id',
  idParams,
  validate({ body: z.object({ url: z.string().url().max(500).optional(), events: eventsSchema.optional(), isActive: z.boolean().optional(), description: z.string().max(200).optional() }) }),
  h(async (req, res) => {
    const w = await repo(req, Webhook).findById(req.params.id);
    if (!w) throw notFound();
    if (req.body.url) await assertSafeWebhookUrl(req.body.url);
    Object.assign(w, req.body);
    await w.save();
    await audit(req, { action: 'webhook.updated', entity: 'webhook', entityId: w._id });
    ok(res, w.toJSON());
  }),
);

webhooksRouter.delete(
  '/:id',
  idParams,
  h(async (req, res) => {
    const w = await repo(req, Webhook).findById(req.params.id);
    if (!w) throw notFound();
    await repo(req, Webhook).deleteOne({ _id: w._id });
    await audit(req, { action: 'webhook.deleted', entity: 'webhook', entityId: w._id });
    ok(res, { deleted: true });
  }),
);

webhooksRouter.get(
  '/:id/deliveries',
  idParams,
  validate({ query: paginationSchema }),
  h(async (req, res) => {
    const q = req.query as any;
    if (!(await repo(req, Webhook).exists({ _id: req.params.id }))) throw notFound();
    const { items, meta } = await repo(req, WebhookDelivery).paginate({ webhookId: req.params.id }, { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => d.toJSON()), meta);
  }),
);

/** Sends a signed `ping` so the admin can verify the endpoint and the signature code. */
webhooksRouter.post(
  '/:id/test',
  idParams,
  h(async (req, res) => {
    const w = await repo(req, Webhook).findById(req.params.id);
    if (!w) throw notFound();
    const d = await enqueue(w, 'ping', { message: 'Webhook test' });
    await deliverDue(1);
    ok(res, (await repo(req, WebhookDelivery).findById(d._id))!.toJSON());
  }),
);

/* ---------------------------------------------------------------------------- delivery */

const DAY = 86_400_000;
const backoff = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attempt - 1)); // 30s, 1m, 2m ... up to 1h

async function enqueue(w: { _id: any; shopId: any }, event: string, data: unknown) {
  const now = new Date();
  return WebhookDelivery.create({
    shopId: w.shopId,
    webhookId: w._id,
    event,
    payload: { id: undefined, event, createdAt: now.toISOString(), data },
    status: 'pending',
    nextAttemptAt: now,
    expiresAt: new Date(now.getTime() + DAY),
  });
}

/** Domain events -> one pending delivery per subscribed, active endpoint of that shop. */
export function startWebhookDispatcher() {
  events.on(async (e: DomainEvent) => {
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(e.name)) return;
    const hooks = await Webhook.find({ shopId: e.shopId, isActive: true, events: e.name }).setOptions({ crossTenant: false });
    for (const w of hooks) await enqueue(w, e.name, e.data);
  });
}

async function deliverOne(d: InstanceType<typeof WebhookDelivery>) {
  const w = await Webhook.findOne({ _id: d.webhookId, shopId: d.shopId });
  if (!w || !w.isActive) {
    d.status = 'failed';
    d.lastError = 'webhook removed or disabled';
    return d.save();
  }
  d.attempts += 1;
  const body = JSON.stringify({ ...(d.payload as object), id: String(d._id) });
  const ts = Math.floor(Date.now() / 1000);
  const signature = hmacSha256(decrypt(w.secretEncrypted), `${ts}.${body}`);
  try {
    const url = await assertSafeWebhookUrl(w.url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OnlineKass-Webhooks/1.0',
        'X-Kass-Event': d.event,
        'X-Kass-Delivery': String(d._id),
        'X-Kass-Timestamp': String(ts),
        // verify with: HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
        'X-Kass-Signature': `sha256=${signature}`,
      },
      body,
    }).finally(() => clearTimeout(timer));
    d.lastStatusCode = res.status;
    if (res.status >= 200 && res.status < 300) {
      d.status = 'delivered';
      d.deliveredAt = new Date();
      d.lastError = undefined;
    } else throw new Error(`HTTP ${res.status}`);
  } catch (err: any) {
    d.lastError = String(err?.message ?? err).slice(0, 300);
    if (new Date() >= d.expiresAt) d.status = 'failed'; // retries for up to 24 hours
    else {
      d.status = 'pending';
      d.nextAttemptAt = new Date(Date.now() + backoff(d.attempts));
    }
  }
  await d.save();
}

/** Worker: claims due deliveries atomically and sends them. Safe with several instances. */
export async function deliverDue(max = 50): Promise<number> {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const d = await WebhookDelivery.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: new Date() } },
      { $set: { status: 'sending' } },
      { new: true, sort: { nextAttemptAt: 1 } },
    ).setOptions({ crossTenant: true });
    if (!d) break;
    try {
      await deliverOne(d);
    } catch (err) {
      logger.error('webhook delivery crashed', { id: String(d._id), err: String(err) });
      d.status = 'pending';
      d.nextAttemptAt = new Date(Date.now() + 60_000);
      await d.save();
    }
    n++;
  }
  return n;
}

/** Reclaims deliveries stuck in "sending" (crashed worker). */
export async function reclaimStuckDeliveries() {
  await WebhookDelivery.updateMany({ status: 'sending', updatedAt: { $lt: new Date(Date.now() - 5 * 60_000) } }, { $set: { status: 'pending' } }).setOptions({ crossTenant: true });
}
