import type { Types } from 'mongoose';
import { tashkentDateString, tashkentDayRange, tashkentPeriod } from '@kass/shared';
import { Branch, Shop } from '../../models/core';
import { DailySummary } from '../../models/integrations';
import { Refund, Sale } from '../../models/sales';

export interface DailyRow {
  date: string;
  branchId: string;
  branchName: string;
  receipts: number;
  revenue: number;
  discounts: number;
  returns: number;
  netRevenue: number;
  cost: number;
}

const dayKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:00' } };

/** Computes one branch-day directly from the receipts. */
export async function computeDay(shopId: Types.ObjectId, branchIds: Types.ObjectId[] | null, fromStr: string, toStr: string) {
  const { from, to } = tashkentPeriod(fromStr, toStr);
  const match: Record<string, unknown> = { shopId, createdAt: { $gte: from, $lt: to } };
  if (branchIds) match.branchId = { $in: branchIds };
  const [sales, costs, refunds] = await Promise.all([
    Sale.aggregate([{ $match: match }, { $group: { _id: { d: dayKey, b: '$branchId' }, receipts: { $sum: 1 }, revenue: { $sum: '$total' }, discounts: { $sum: '$discount' } } }]),
    Sale.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $group: { _id: { d: dayKey, b: '$branchId' }, cost: { $sum: { $multiply: [{ $subtract: ['$lines.qty', { $ifNull: ['$lines.refundedQty', 0] }] }, { $ifNull: ['$lines.unitCost', 0] }] } } } },
    ]),
    Refund.aggregate([{ $match: match }, { $group: { _id: { d: dayKey, b: '$branchId' }, returns: { $sum: '$total' } } }]),
  ]);
  const map = new Map<string, { date: string; branchId: string; receipts: number; revenue: number; discounts: number; returns: number; cost: number }>();
  const get = (id: { d: string; b: Types.ObjectId }) => {
    const k = `${id.d}|${id.b}`;
    if (!map.has(k)) map.set(k, { date: id.d, branchId: String(id.b), receipts: 0, revenue: 0, discounts: 0, returns: 0, cost: 0 });
    return map.get(k)!;
  };
  sales.forEach((r) => Object.assign(get(r._id), { receipts: r.receipts, revenue: r.revenue, discounts: r.discounts }));
  costs.forEach((r) => (get(r._id).cost = r.cost));
  refunds.forEach((r) => (get(r._id).returns = r.returns));
  return [...map.values()];
}

/**
 * Daily totals per branch. Days before today come from the nightly pre-computed summaries when
 * available (otherwise they are computed and cached); today is always live.
 */
export async function dailyTotals(shopId: Types.ObjectId, branchIds: Types.ObjectId[] | null, fromStr: string, toStr: string): Promise<DailyRow[]> {
  const today = tashkentDateString(new Date());
  const branches = await Branch.find({ shopId }).select('name').lean();
  const names = new Map(branches.map((b) => [String(b._id), b.name]));
  const pastTo = toStr < today ? toStr : tashkentDateString(new Date(Date.now() - 86_400_000));
  const rows: DailyRow[] = [];

  if (fromStr <= pastTo) {
    const stored = await DailySummary.find({ shopId, date: { $gte: fromStr, $lte: pastTo }, ...(branchIds ? { branchId: { $in: branchIds } } : {}) }).lean();
    const have = new Set(stored.map((s) => s.date));
    // any day without a stored summary is computed now and kept for next time
    const missing: string[] = [];
    for (let d = tashkentDayRange(fromStr).from; tashkentDateString(d) <= pastTo; d = new Date(d.getTime() + 86_400_000)) if (!have.has(tashkentDateString(d))) missing.push(tashkentDateString(d));
    if (missing.length) {
      const live = await computeDay(shopId, branchIds, missing[0], missing[missing.length - 1]);
      for (const r of live.filter((x) => missing.includes(x.date))) {
        await DailySummary.updateOne({ shopId, branchId: r.branchId, date: r.date }, { $set: { receipts: r.receipts, revenue: r.revenue, discounts: r.discounts, returns: r.returns, cost: r.cost, computedAt: new Date() } }, { upsert: true });
        stored.push({ ...r, shopId, computedAt: new Date() } as any);
      }
    }
    for (const s of stored) rows.push({ date: s.date, branchId: String(s.branchId), branchName: names.get(String(s.branchId)) ?? '', receipts: s.receipts, revenue: s.revenue, discounts: s.discounts, returns: s.returns, netRevenue: s.revenue - s.returns, cost: s.cost });
  }
  if (toStr >= today) {
    const live = await computeDay(shopId, branchIds, today < fromStr ? fromStr : today, toStr);
    for (const r of live) rows.push({ ...r, branchName: names.get(r.branchId) ?? '', netRevenue: r.revenue - r.returns });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.branchName.localeCompare(b.branchName));
}

/** Nightly job: stores yesterday's summaries for every shop. Idempotent. */
export async function precomputeYesterday(): Promise<number> {
  const y = tashkentDateString(new Date(Date.now() - 86_400_000));
  const shops = await Shop.find({ status: 'active' }).select('_id').lean();
  let n = 0;
  for (const s of shops) {
    const rows = await computeDay(s._id, null, y, y);
    for (const r of rows) {
      await DailySummary.updateOne({ shopId: s._id, branchId: r.branchId, date: r.date }, { $set: { receipts: r.receipts, revenue: r.revenue, discounts: r.discounts, returns: r.returns, cost: r.cost, computedAt: new Date() } }, { upsert: true });
      n++;
    }
  }
  return n;
}
