import { addDays } from '@kass/shared';
import { auditSystem } from '../lib/audit';
import { events } from '../lib/events';
import { getGraceDays } from '../lib/platform';
import { revokeShopSessions } from '../lib/tokens';
import { Shop, Terminal } from '../models/core';

/**
 * Shops whose paid period AND grace period are over become "expired": sessions and agent
 * tokens are revoked immediately. Data is never deleted. Idempotent via `expiryProcessedAt`.
 * (Access is also refused on every request by the tenant check, so this is belt and braces.)
 */
export async function expireShops(now = new Date()): Promise<number> {
  const grace = await getGraceDays();
  const cutoff = addDays(now, -grace);
  const shops = await Shop.find({
    status: 'active',
    paidUntil: { $ne: null, $lt: cutoff },
    expiryProcessedAt: null,
  });
  for (const shop of shops) {
    await revokeShopSessions(shop._id);
    await Terminal.updateMany({ shopId: shop._id }, { $unset: { agentTokenHash: '', pairingCodeHash: '' } });
    shop.expiryProcessedAt = now;
    await shop.save();
    await auditSystem({ action: 'shop.expired', entity: 'shop', entityId: shop._id, shopId: null });
    events.emit({ name: 'shop.expired', shopId: shop._id, data: { shopName: shop.name } });
  }
  return shops.length;
}

/** Clears the processed flag after a payment so a later lapse is handled again. */
export async function clearExpiryFlag(shopId: unknown) {
  await Shop.updateOne({ _id: shopId }, { $unset: { expiryProcessedAt: '' } });
}
