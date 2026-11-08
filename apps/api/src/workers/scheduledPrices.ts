import { PriceChange } from '../models/catalog';
import { applyPrices } from '../modules/catalog/priceService';
import { auditSystem } from '../lib/audit';

/**
 * Applies scheduled price changes whose time has come. Each change is claimed atomically
 * (scheduled -> applying) so several workers/instances never apply it twice.
 */
export async function applyScheduledPrices(now = new Date()): Promise<number> {
  let applied = 0;
  for (;;) {
    const change = await PriceChange.findOneAndUpdate(
      { status: 'scheduled', effectiveAt: { $lte: now } },
      { $set: { status: 'applying' } },
      { new: true, sort: { effectiveAt: 1 } },
    ).setOptions({ crossTenant: true });
    if (!change) break;
    try {
      const [result] = await applyPrices({
        shopId: change.shopId,
        userId: change.userId ?? undefined,
        changes: [{ productId: change.productId, branchId: change.branchId, price: change.newPrice ?? null }],
        source: 'scheduled',
        history: false,
      });
      change.status = 'applied';
      change.oldPrice = result ? result.oldPrice : change.newPrice;
      await change.save();
      applied++;
      await auditSystem({ action: 'prices.scheduled_applied', shopId: change.shopId, entity: 'price_change', entityId: change._id });
    } catch (err) {
      // Product/branch vanished or similar: park it as cancelled so it is not retried forever.
      change.status = 'cancelled';
      await change.save();
    }
  }
  return applied;
}
