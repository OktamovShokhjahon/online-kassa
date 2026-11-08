import { DEFAULT_PLATFORM_SETTINGS, addDays, type ShopEffectiveStatus } from '@kass/shared';
import { PlatformSettings, type ShopDoc } from '../models/core';

/** The singleton platform settings document (created on first use). */
export async function getPlatformSettings() {
  const doc = await PlatformSettings.findOneAndUpdate(
    { key: 'platform' },
    { $setOnInsert: { key: 'platform' } },
    { upsert: true, new: true },
  );
  return doc;
}

let graceCache: { value: number; at: number } | null = null;

/** Grace period length; cached for a few seconds because every request needs it. */
export async function getGraceDays(): Promise<number> {
  if (graceCache && Date.now() - graceCache.at < 10_000) return graceCache.value;
  const s = await getPlatformSettings();
  const value = s.graceDays ?? DEFAULT_PLATFORM_SETTINGS.graceDays;
  graceCache = { value, at: Date.now() };
  return value;
}

export function invalidatePlatformCache() {
  graceCache = null;
}

export interface EffectiveStatus {
  status: ShopEffectiveStatus;
  inGrace: boolean;
  graceDaysLeft: number | null;
}

/**
 * Derives trial/active/expired/blocked from the stored status and `paidUntil`.
 * After `paidUntil` a grace period (default 3 days) allows login with a warning;
 * past it the shop is "expired" and logins are refused.
 */
export function effectiveStatus(
  shop: Pick<ShopDoc, 'status' | 'paidUntil'>,
  graceDays: number,
  now = new Date(),
): EffectiveStatus {
  if (shop.status === 'blocked') return { status: 'blocked', inGrace: false, graceDaysLeft: null };
  if (!shop.paidUntil) return { status: 'trial', inGrace: false, graceDaysLeft: null };
  const paidUntil = new Date(shop.paidUntil);
  if (now <= paidUntil) return { status: 'active', inGrace: false, graceDaysLeft: null };
  const graceEnd = addDays(paidUntil, graceDays);
  if (now <= graceEnd) {
    const left = Math.max(1, Math.ceil((graceEnd.getTime() - now.getTime()) / 86_400_000));
    return { status: 'active', inGrace: true, graceDaysLeft: left };
  }
  return { status: 'expired', inGrace: false, graceDaysLeft: null };
}

/** Mongo filter that matches shops with the given effective status. */
export function statusFilter(
  status: ShopEffectiveStatus,
  graceDays: number,
  now = new Date(),
): Record<string, unknown> {
  const graceCutoff = addDays(now, -graceDays);
  switch (status) {
    case 'blocked':
      return { status: 'blocked' };
    case 'trial':
      return { status: 'active', paidUntil: null };
    case 'active':
      return { status: 'active', paidUntil: { $ne: null, $gte: graceCutoff } };
    case 'expired':
      return { status: 'active', paidUntil: { $ne: null, $lt: graceCutoff } };
  }
}

/** Next free 1-9999 shop code for internal barcodes (atomic). */
export async function nextShopCode(): Promise<number> {
  await getPlatformSettings();
  const doc = await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { nextShopCode: 1 } }, { new: true });
  return (doc!.nextShopCode ?? 2) - 1;
}
