import type { Types } from 'mongoose';
import { formatMoney, tashkentDateString, translate, type Currency, type Language } from '@kass/shared';
import { events, type DomainEvent } from '../../lib/events';
import { logger } from '../../lib/logger';
import { sendTelegram } from '../../lib/telegram';
import { Branch, Shop } from '../../models/core';
import { TelegramRecipient, type TelegramRecipientDoc } from '../../models/integrations';
import { Customer, Shift } from '../../models/sales';
import { Product } from '../../models/catalog';
import { Stock } from '../../models/stock';
import { dailyTotals } from '../reports/daily';

type Pref = 'dailySummary' | 'shiftClosed' | 'refundAbove' | 'lowStock' | 'negativeStock' | 'longShift' | 'debtsOverdue' | 'subscriptionExpiring';

const enabled = (r: TelegramRecipientDoc, pref: Pref) => {
  const v = (r.notifications as any)?.[pref];
  return typeof v === 'object' ? !!v?.enabled : v !== false;
};

/** Sends a message to every recipient of a shop (or the platform: shopId = null) that wants it. */
export async function notify(shopId: Types.ObjectId | string | null, pref: Pref, build: (lang: Language, r: TelegramRecipientDoc) => string | null) {
  const recipients = await TelegramRecipient.find({ shopId }).setOptions({ crossTenant: shopId === null });
  let sent = 0;
  for (const r of recipients) {
    if (!enabled(r, pref)) continue;
    const text = build((r.language as Language) ?? 'uz', r);
    if (text && (await sendTelegram(r.chatId, text))) sent++;
  }
  return sent;
}

const money = (n: number, cur: Currency, lang: Language) => formatMoney(n, cur, lang);

async function shopCtx(shopId: Types.ObjectId | string) {
  const shop = await Shop.findById(shopId).select('name currency').lean();
  return { name: shop?.name ?? '', currency: (shop?.currency ?? 'UZS') as Currency };
}
async function branchName(shopId: unknown, branchId: unknown) {
  return (await Branch.findOne({ _id: branchId as any, shopId: shopId as any }).select('name').lean())?.name ?? '';
}
async function productName(shopId: unknown, productId: unknown) {
  return (await Product.findOne({ _id: productId as any, shopId: shopId as any }).select('name').lean())?.name ?? '';
}

/** Subscribes the notification rules to the domain event bus (spec 11.4). */
export function startNotifier() {
  events.on(async (e: DomainEvent) => {
    const d = e.data as any;
    try {
      switch (e.name) {
        case 'shift.closed': {
          const s = await shopCtx(e.shopId);
          const branch = await branchName(e.shopId, d.branchId);
          await notify(e.shopId, 'shiftClosed', (l) =>
            translate(l, 'telegram.shiftClosed', { cashier: d.cashier ?? '', branch, expected: money(d.expectedCash, s.currency, l), counted: money(d.countedCash, s.currency, l), difference: money(d.difference, s.currency, l) }),
          );
          break;
        }
        case 'sale.refunded': {
          const s = await shopCtx(e.shopId);
          const branch = await branchName(e.shopId, d.branchId);
          await notify(e.shopId, 'refundAbove', (l, r) => ((r.notifications as any)?.refundAbove?.amount ?? 0) <= d.total ? translate(l, 'telegram.refund', { number: d.number, amount: money(d.total, s.currency, l), branch }) : null);
          break;
        }
        case 'stock.low':
        case 'stock.negative': {
          const [product, branch] = await Promise.all([productName(e.shopId, d.productId), branchName(e.shopId, d.branchId)]);
          const low = e.name === 'stock.low';
          await notify(e.shopId, low ? 'lowStock' : 'negativeStock', (l) => translate(l, low ? 'telegram.lowStock' : 'telegram.negativeStock', { product, quantity: d.quantity, min: d.minStock ?? 0, branch }));
          break;
        }
        case 'shift.long_open': {
          await notify(e.shopId, 'longShift', (l) => translate(l, 'telegram.longShift', { cashier: d.cashier ?? '', branch: d.branch ?? '', hours: d.hours }));
          break;
        }
        case 'debt.overdue': {
          const s = await shopCtx(e.shopId);
          await notify(e.shopId, 'debtsOverdue', (l) => translate(l, 'telegram.debtsOverdue', { count: d.count, total: money(d.total, s.currency, l) }));
          break;
        }
        case 'shop.expiring': {
          await notify(e.shopId, 'subscriptionExpiring', (l) => translate(l, 'telegram.subscriptionExpiring', { days: d.days }));
          await notify(null, 'subscriptionExpiring', (l) => translate(l, 'telegram.shopExpiring', { shop: d.shopName, days: d.days }));
          break;
        }
        case 'shop.expired': {
          await notify(null, 'subscriptionExpiring', (l) => translate(l, 'telegram.shopExpired', { shop: d.shopName }));
          break;
        }
        case 'server.error': {
          await notify(null, 'subscriptionExpiring', (l) => translate(l, 'telegram.serverError', { message: String(d.message).slice(0, 200), id: d.requestId ?? '-' }));
          break;
        }
      }
    } catch (err) {
      logger.error('notifier failed', { event: e.name, err: String(err) });
    }
  });
}

/* ------------------------------------------------------------------------------ jobs */

const hhmm = (d: Date) => {
  const t = new Date(d.getTime() + 5 * 3600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
};

/** Daily summary at each recipient's chosen time (sent once per day, also after a missed tick). */
export async function dailySummaryJob(now = new Date()): Promise<number> {
  const today = tashkentDateString(now);
  const time = hhmm(now);
  const due = await TelegramRecipient.find({ shopId: { $ne: null }, lastDailySummaryDate: { $ne: today }, 'notifications.dailySummary.enabled': true, 'notifications.dailySummary.time': { $lte: time } });
  let n = 0;
  const cache = new Map<string, Awaited<ReturnType<typeof dailyTotals>>>();
  for (const r of due) {
    const key = String(r.shopId);
    if (!cache.has(key)) cache.set(key, await dailyTotals(r.shopId!, null, today, today));
    const rows = cache.get(key)!;
    const s = await shopCtx(r.shopId!);
    const t = rows.reduce((a, x) => ({ receipts: a.receipts + x.receipts, revenue: a.revenue + x.revenue, returns: a.returns + x.returns }), { receipts: 0, revenue: 0, returns: 0 });
    const l = (r.language as Language) ?? 'uz';
    const ok = await sendTelegram(r.chatId, translate(l, 'telegram.dailySummary', { shop: s.name, date: today, revenue: money(t.revenue - t.returns, s.currency, l), receipts: t.receipts, average: money(t.receipts ? Math.round(t.revenue / t.receipts) : 0, s.currency, l), returns: money(t.returns, s.currency, l) }));
    if (ok) {
      r.lastDailySummaryDate = today;
      await r.save();
      n++;
    }
  }
  return n;
}

/** Shifts open longer than the shop's limit (default 24 h) are reported once to the owner. */
export async function longShiftJob(now = new Date()): Promise<number> {
  // shifts the desk program runs itself are closed every day automatically: no alert for them
  const open = await Shift.find({ status: 'open', longOpenNotifiedAt: null, autoManaged: { $ne: true } }).setOptions({ crossTenant: true }).limit(500);
  let n = 0;
  for (const s of open) {
    const shop = await Shop.findById(s.shopId).select('settings.openShiftAlertHours').lean();
    const limit = shop?.settings?.openShiftAlertHours ?? 24;
    const hours = (now.getTime() - s.openedAt.getTime()) / 3_600_000;
    if (hours < limit) continue;
    s.longOpenNotifiedAt = now;
    await s.save();
    events.emit({ name: 'shift.long_open', shopId: s.shopId, data: { shiftId: String(s._id), cashier: s.cashierName, branch: await branchName(s.shopId, s.branchId), hours: Math.floor(hours) } });
    n++;
  }
  return n;
}

/** Once a day per recipient: customers whose debt is older than 30 days. */
export async function debtReminderJob(now = new Date()): Promise<number> {
  const today = tashkentDateString(now);
  if (hhmm(now) < '10:00') return 0;
  const recipients = await TelegramRecipient.find({ shopId: { $ne: null }, lastDebtReminderDate: { $ne: today }, 'notifications.debtsOverdue': { $ne: false } });
  let n = 0;
  const seen = new Map<string, { count: number; total: number }>();
  for (const r of recipients) {
    const k = String(r.shopId);
    if (!seen.has(k)) {
      const debtors = await Customer.find({ shopId: r.shopId, debtBalance: { $gt: 0 }, debtSince: { $lt: new Date(now.getTime() - 30 * 86_400_000) } }).select('debtBalance').lean();
      seen.set(k, { count: debtors.length, total: debtors.reduce((s, c) => s + c.debtBalance, 0) });
    }
    const v = seen.get(k)!;
    r.lastDebtReminderDate = today;
    await r.save();
    if (v.count) {
      const s = await shopCtx(r.shopId!);
      const l = (r.language as Language) ?? 'uz';
      if (await sendTelegram(r.chatId, translate(l, 'telegram.debtsOverdue', { count: v.count, total: money(v.total, s.currency, l) }))) n++;
    }
  }
  return n;
}

/** Subscription ends within 3 days: remind the owner and the platform, once per day. */
export async function expiryNoticeJob(now = new Date()): Promise<number> {
  const today = tashkentDateString(now);
  const shops = await Shop.find({ status: 'active', paidUntil: { $gt: now, $lte: new Date(now.getTime() + 3 * 86_400_000) } }).lean();
  let n = 0;
  for (const shop of shops) {
    const recipients = await TelegramRecipient.find({ shopId: shop._id, lastExpiryNoticeDate: { $ne: today } });
    if (!recipients.length) continue;
    const days = Math.max(1, Math.ceil((shop.paidUntil!.getTime() - now.getTime()) / 86_400_000));
    events.emit({ name: 'shop.expiring', shopId: shop._id, data: { days, shopName: shop.name } });
    for (const r of recipients) {
      r.lastExpiryNoticeDate = today;
      await r.save();
    }
    n++;
  }
  return n;
}
