import type { ClientSession, Types } from 'mongoose';
import { notFound } from '../../lib/errors';
import { events } from '../../lib/events';
import { oid } from '../../lib/util';
import { Price, PriceChange, Product } from '../../models/catalog';
import { Branch } from '../../models/core';
import { TenantRepo } from '../../repo/tenantRepo';

export interface PriceChangeInput {
  productId: string | Types.ObjectId;
  branchId: string | Types.ObjectId;
  /** null removes the price (the product can no longer be sold in that branch). */
  price: number | null;
}

export type PriceSource = 'manual' | 'bulk' | 'copy' | 'import' | 'scheduled' | 'branch_copy';

export interface AppliedChange {
  productId: string;
  branchId: string;
  oldPrice: number | null;
  newPrice: number | null;
}

/**
 * The single place where selling prices are written. Validates that every product and branch
 * belongs to the shop, skips no-op changes, writes the new prices with one bulkWrite and
 * records every change in the price history. Callers are responsible for the "shop admin only"
 * rule (prices can never be delegated) and for auditing.
 */
export async function applyPrices(opts: {
  shopId: Types.ObjectId;
  userId: Types.ObjectId | undefined;
  changes: PriceChangeInput[];
  source: PriceSource;
  /** false when the caller keeps its own history row (scheduled changes). */
  history?: boolean;
  session?: ClientSession | null;
}): Promise<AppliedChange[]> {
  const { shopId, userId, source, session } = opts;
  const prices = new TenantRepo(Price, shopId);
  const changes = opts.changes;
  if (!changes.length) return [];

  const productIds = [...new Set(changes.map((c) => String(c.productId)))];
  const branchIds = [...new Set(changes.map((c) => String(c.branchId)))];
  const [pCount, bCount] = await Promise.all([
    new TenantRepo(Product, shopId).count({ _id: { $in: productIds } }),
    new TenantRepo(Branch, shopId).count({ _id: { $in: branchIds } }),
  ]);
  if (pCount !== productIds.length) throw notFound('PRODUCT_NOT_FOUND');
  if (bCount !== branchIds.length) throw notFound('BRANCH_NOT_FOUND');

  const existing = await prices
    .find({ productId: { $in: productIds }, branchId: { $in: branchIds } }, { session })
    .select('productId branchId price')
    .lean();
  const current = new Map(existing.map((p) => [`${p.productId}:${p.branchId}`, p.price as number]));

  // Last change per product+branch wins.
  const latest = new Map<string, PriceChangeInput>();
  for (const c of changes) latest.set(`${c.productId}:${c.branchId}`, c);

  const ops: any[] = [];
  const applied: AppliedChange[] = [];
  for (const [key, c] of latest) {
    const old = current.get(key) ?? null;
    if (old === c.price) continue;
    const filter = { productId: oid(c.productId), branchId: oid(c.branchId) };
    if (c.price === null) ops.push({ deleteOne: { filter } });
    else ops.push({ updateOne: { filter, update: { $set: { price: c.price, updatedBy: userId } }, upsert: true } });
    applied.push({ productId: String(c.productId), branchId: String(c.branchId), oldPrice: old, newPrice: c.price });
  }
  if (!ops.length) return [];
  await prices.bulkWrite(ops, session);

  if (opts.history !== false) {
    const now = new Date();
    await new TenantRepo(PriceChange, shopId).insertMany(
      applied.map((a) => ({
        productId: oid(a.productId),
        branchId: oid(a.branchId),
        oldPrice: a.oldPrice,
        newPrice: a.newPrice,
        effectiveAt: now,
        status: 'applied',
        userId,
        source,
      })),
      session,
    );
  }
  events.emit({ name: 'price.changed', shopId, data: { source, count: applied.length, changes: applied.slice(0, 50) } });
  return applied;
}
