import { Router, type Request } from 'express';
import { z } from 'zod';
import { languageSchema, objectId, translate, type Language } from '@kass/shared';
import { env } from '../../config/env';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { forbidden, notFound } from '../../lib/errors';
import { auth, h, ok, repo } from '../../lib/http';
import { sendTelegram, telegramWebhookSecret } from '../../lib/telegram';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Shop, User } from '../../models/core';
import { TelegramLink, TelegramRecipient } from '../../models/integrations';

const LINK_TTL_MS = 15 * 60_000;
const idParams = validate({ params: z.object({ id: objectId }) });

async function createLink(req: Request, shopId: any) {
  const a = auth(req);
  const token = randomToken(18);
  await TelegramLink.create({ tokenHash: sha256(token), userId: a.userId, shopId, expiresAt: new Date(Date.now() + LINK_TTL_MS) });
  const url = env.TELEGRAM_BOT_USERNAME ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${token}` : null;
  return { token, url, expiresAt: new Date(Date.now() + LINK_TTL_MS), command: `/start ${token}` };
}

/* ===================================================== shop admin (spec 11.4) */

export const telegramRouter = Router();

/** The bot calls this with updates (`setWebhook` to `/api/v1/telegram/webhook/<secret>`). */
telegramRouter.post(
  '/webhook/:secret',
  h(async (req, res) => {
    if (req.params.secret !== telegramWebhookSecret()) throw forbidden();
    const msg = req.body?.message;
    const chatId = msg?.chat?.id !== undefined ? String(msg.chat.id) : null;
    const text: string = String(msg?.text ?? '').trim();
    if (!chatId || !text) return void res.json({ ok: true });

    const [cmd, arg] = text.split(/\s+/, 2);
    const lang = ((msg.from?.language_code ?? 'uz').slice(0, 2) as Language);
    const l: Language = ['uz', 'ru', 'en'].includes(lang) ? lang : 'uz';

    if (cmd === '/start' && arg) {
      const link = await TelegramLink.findOneAndDelete({ tokenHash: sha256(arg), expiresAt: { $gt: new Date() } });
      if (!link) await sendTelegram(chatId, translate(l, 'telegram.invalidLink'));
      else {
        const user = await User.findOne({ _id: link.userId }).setOptions({ crossTenant: true });
        const shop = link.shopId ? await Shop.findById(link.shopId).select('name').lean() : null;
        const rl = (user?.language as Language) ?? l;
        await TelegramRecipient.updateOne({ shopId: link.shopId, userId: link.userId, chatId }, { $set: { username: msg.from?.username, language: rl }, $setOnInsert: { notifications: {} } }, { upsert: true });
        await sendTelegram(chatId, translate(rl, 'telegram.linked', { name: user?.fullName ?? '', shop: shop?.name ?? translate(rl, 'telegram.platformName') }));
      }
    } else if (cmd === '/stop') {
      await TelegramRecipient.deleteMany({ chatId }).setOptions({ crossTenant: true } as any);
      await sendTelegram(chatId, translate(l, 'telegram.stopped'));
    } else {
      await sendTelegram(chatId, translate(l, 'telegram.welcome'));
    }
    res.json({ ok: true });
  }),
);

const notificationsPatch = z
  .object({
    dailySummary: z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).partial(),
    shiftClosed: z.boolean(),
    refundAbove: z.object({ enabled: z.boolean(), amount: z.number().int().min(0) }).partial(),
    lowStock: z.boolean(),
    negativeStock: z.boolean(),
    longShift: z.boolean(),
    debtsOverdue: z.boolean(),
    subscriptionExpiring: z.boolean(),
  })
  .partial();

telegramRouter.post('/link', authenticate, requirePermission('settings.manage'), h(async (req, res) => ok(res, await createLink(req, auth(req).shopId))));

telegramRouter.get(
  '/recipients',
  authenticate,
  requirePermission('settings.manage'),
  h(async (req, res) => {
    const list = await repo(req, TelegramRecipient).find({}, { sort: '-createdAt' });
    const users = await User.find({ shopId: auth(req).shopId, _id: { $in: list.map((r) => r.userId) } }).select('fullName').lean();
    const un = new Map(users.map((u) => [String(u._id), u.fullName]));
    ok(res, list.map((r) => ({ ...r.toJSON(), userName: un.get(String(r.userId)) })));
  }),
);

telegramRouter.patch(
  '/recipients/:id',
  authenticate,
  requirePermission('settings.manage'),
  idParams,
  validate({ body: z.object({ language: languageSchema.optional(), notifications: notificationsPatch.optional() }) }),
  h(async (req, res) => {
    const r = await repo(req, TelegramRecipient).findById(req.params.id);
    if (!r) throw notFound();
    if (req.body.language) r.language = req.body.language;
    for (const [k, v] of Object.entries(req.body.notifications ?? {})) {
      if (v !== null && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) r.set(`notifications.${k}.${sk}`, sv);
      else r.set(`notifications.${k}`, v);
    }
    await r.save();
    await audit(req, { action: 'telegram.recipient_updated', entity: 'telegram_recipient', entityId: r._id });
    ok(res, r.toJSON());
  }),
);

telegramRouter.delete(
  '/recipients/:id',
  authenticate,
  requirePermission('settings.manage'),
  idParams,
  h(async (req, res) => {
    const r = await repo(req, TelegramRecipient).findById(req.params.id);
    if (!r) throw notFound();
    await repo(req, TelegramRecipient).deleteOne({ _id: r._id });
    ok(res, { deleted: true });
  }),
);

telegramRouter.post(
  '/test',
  authenticate,
  requirePermission('settings.manage'),
  h(async (req, res) => {
    const list = await repo(req, TelegramRecipient).find({});
    let sent = 0;
    for (const r of list) if (await sendTelegram(r.chatId, translate((r.language as Language) ?? 'uz', 'telegram.test'))) sent++;
    ok(res, { sent });
  }),
);

/* ====================================================== superadmin alerts (spec 4.6) */

export const adminTelegramRouter = Router();
adminTelegramRouter.use(authenticate, requireRole('superadmin'));
adminTelegramRouter.post('/link', h(async (req, res) => ok(res, await createLink(req, null))));
adminTelegramRouter.get('/recipients', h(async (_req, res) => ok(res, (await TelegramRecipient.find({ shopId: null })).map((r) => r.toJSON()))));
adminTelegramRouter.delete('/recipients/:id', idParams, h(async (req, res) => {
  const r = await TelegramRecipient.deleteOne({ _id: req.params.id, shopId: null });
  if (!r.deletedCount) throw notFound();
  ok(res, { deleted: true });
}));
