import type { Model, Types } from 'mongoose';
import { RESET_GROUPS, withResetDependencies, type ResetGroup } from '@kass/shared';
import { Category, PriceChange, Price, Product } from '../../models/catalog';
import { AuditLog, Branch, Counter, Session, Shop, Terminal, User } from '../../models/core';
import { ApiKey, DailySummary, TelegramLink, TelegramRecipient, Webhook, WebhookDelivery } from '../../models/integrations';
import { BonusTransaction, CashOperation, Customer, CustomerPayment, DeclinedSale, FiscalLog, Promotion, Refund, Sale, Shift } from '../../models/sales';
import { GoodsReceipt, Stock, StockCount, StockMovement, Supplier, SupplierPayment, SupplierReturn, Transfer, WriteOff } from '../../models/stock';

/**
 * "Reset" on the superadmin shop page: wipes chosen kinds of data of one shop. The shop, its owner
 * account and its first branch always stay; everything else can go, group by group.
 */

type Part = { model: Model<any>; filter?: Record<string, unknown> };

interface Ctx {
  shopId: Types.ObjectId;
  firstBranchId: Types.ObjectId | null;
  groups: Set<ResetGroup>;
}

/** The records each group deletes (also used for the counts shown before deleting). */
function parts(g: ResetGroup, c: Ctx): Part[] {
  const notFirst = c.firstBranchId ? { _id: { $ne: c.firstBranchId } } : {};
  switch (g) {
    case 'sales':
      return [{ model: Sale }, { model: Refund }, { model: DeclinedSale }, { model: Shift }, { model: CashOperation }, { model: FiscalLog }, { model: DailySummary }];
    case 'warehouse':
      return [{ model: GoodsReceipt }, { model: SupplierReturn }, { model: Transfer }, { model: WriteOff }, { model: StockCount }, { model: StockMovement }, { model: Stock }, { model: SupplierPayment }];
    case 'suppliers':
      return [{ model: Supplier }, { model: SupplierPayment }];
    case 'products':
      return [{ model: Product }, { model: Price }, { model: PriceChange }];
    case 'categories':
      return [{ model: Category }];
    case 'promotions':
      return [{ model: Promotion }];
    case 'customers':
      return [{ model: Customer }, { model: CustomerPayment }, { model: BonusTransaction }];
    case 'staff':
      return [{ model: User, filter: { role: { $ne: 'shop_admin' } } }];
    case 'programs':
      return [{ model: ApiKey, filter: { 'program.kind': { $exists: true } } }];
    case 'integrations':
      return [{ model: ApiKey, filter: { 'program.kind': { $exists: false } } }, { model: Webhook }, { model: WebhookDelivery }, { model: TelegramRecipient }, { model: TelegramLink }];
    case 'branches':
      return [{ model: Branch, filter: notFirst }, { model: Terminal }];
    case 'audit':
      return [{ model: AuditLog }];
  }
}

async function context(shopId: Types.ObjectId, groups: ResetGroup[]): Promise<Ctx> {
  const first = await Branch.findOne({ shopId }).sort({ createdAt: 1, _id: 1 }).select('_id').lean();
  return { shopId, firstBranchId: (first?._id as Types.ObjectId) ?? null, groups: new Set(groups) };
}

/** How many records each group would delete: its main record (the first part, e.g. sales, products) and everything together. */
export async function resetPreview(shopId: Types.ObjectId) {
  const c = await context(shopId, [...RESET_GROUPS]);
  const out: Array<{ group: ResetGroup; main: number; total: number }> = [];
  for (const g of RESET_GROUPS) {
    const counts = await Promise.all(parts(g, c).map((p) => p.model.countDocuments({ shopId, ...(p.filter ?? {}) })));
    out.push({ group: g, main: counts[0] ?? 0, total: counts.reduce((s, n) => s + n, 0) });
  }
  return out;
}

const COUNTERS: Partial<Record<ResetGroup, RegExp>> = {
  sales: /^(sale:|refund$)/,
  warehouse: /^(goodsReceipt|supplierReturn|transfer|writeOff|stockCount)$/,
  products: /^internalBarcode$/,
};

/** Deletes the chosen groups (plus what they need). Returns the number of records removed per group. */
export async function resetShop(shopId: Types.ObjectId, chosen: ResetGroup[]) {
  const groups = withResetDependencies(chosen);
  const c = await context(shopId, groups);
  const deleted: Partial<Record<ResetGroup, number>> = {};

  // staff: their sessions and Telegram links go with them
  if (c.groups.has('staff')) {
    const ids = (await User.find({ shopId, role: { $ne: 'shop_admin' } }).select('_id').lean()).map((u) => u._id);
    await Session.deleteMany({ shopId, userId: { $in: ids } });
    await TelegramRecipient.deleteMany({ shopId, userId: { $in: ids } });
  }
  // branches: their prices go, and staff lose the deleted branches
  if (c.groups.has('branches') && c.firstBranchId) {
    const gone = (await Branch.find({ shopId, _id: { $ne: c.firstBranchId } }).select('_id').lean()).map((b) => b._id);
    if (gone.length) {
      await Price.deleteMany({ shopId, branchId: { $in: gone } });
      await User.updateMany({ shopId }, { $pull: { branchIds: { $in: gone } } });
    }
  }

  for (const g of groups) {
    let n = 0;
    for (const p of parts(g, c)) n += (await p.model.deleteMany({ shopId, ...(p.filter ?? {}) })).deletedCount ?? 0;
    deleted[g] = n;
    const rx = COUNTERS[g];
    if (rx) await Counter.deleteMany({ shopId, key: rx });
  }

  // keep what stays consistent with what went
  if (c.groups.has('categories') && !c.groups.has('products')) await Product.updateMany({ shopId }, { $unset: { categoryId: 1 } });
  if (c.groups.has('warehouse') && !c.groups.has('suppliers')) await Supplier.updateMany({ shopId }, { $set: { balance: 0 } });
  if (c.groups.has('sales') && !c.groups.has('warehouse')) await rebuildStockWithoutSales(shopId);
  if (c.groups.has('sales') && c.groups.has('warehouse')) await Shop.updateOne({ _id: shopId }, { $set: { currencyLocked: false } });

  return { groups, deleted };
}

/** Sales are gone but the warehouse stays: drop their stock movements and recount the balances. */
async function rebuildStockWithoutSales(shopId: Types.ObjectId) {
  await StockMovement.deleteMany({ shopId, docType: { $in: ['sale', 'refund'] } });
  const sums = await StockMovement.aggregate([{ $match: { shopId } }, { $group: { _id: { b: '$branchId', p: '$productId' }, q: { $sum: '$quantity' } } }]);
  const map = new Map(sums.map((s: any) => [`${s._id.b}:${s._id.p}`, s.q as number]));
  const stocks = await Stock.find({ shopId }).select('branchId productId').lean();
  const ops = stocks.map((s) => ({ updateOne: { filter: { _id: s._id, shopId }, update: { $set: { quantity: Math.round((map.get(`${s.branchId}:${s.productId}`) ?? 0) * 1000) / 1000 } } } }));
  if (ops.length) await Stock.bulkWrite(ops as any);
}
