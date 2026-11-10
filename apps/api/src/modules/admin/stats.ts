import { tashkentDateString, tashkentDayRange } from '@kass/shared';
import type { Types } from 'mongoose';
import { Product } from '../../models/catalog';
import { Branch, Terminal, User } from '../../models/core';
import { DeclinedSale, Refund, Sale } from '../../models/sales';
import { GoodsReceipt } from '../../models/stock';

export interface CurrencyTotals {
  currency: string;
  volume: number;
  receipts: number;
}
export interface PlatformSalesStats {
  today: CurrencyTotals[];
  last7Days: CurrencyTotals[];
  last30Days: CurrencyTotals[];
}

async function totals(from: Date, to: Date): Promise<CurrencyTotals[]> {
  // The one place that deliberately reads across tenants: platform-wide totals, per currency.
  const rows = await Sale.aggregate([
    { $match: { createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: '$currency', volume: { $sum: '$total' }, receipts: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).option({ crossTenant: true } as any);
  return rows.map((r) => ({ currency: r._id ?? 'UZS', volume: r.volume, receipts: r.receipts }));
}

/** Platform-wide sales volume and receipt count for today, 7 and 30 days, per currency (spec 4.1). */
export async function platformSalesStats(now: Date): Promise<PlatformSalesStats> {
  const today = tashkentDayRange(tashkentDateString(now));
  const days = (n: number) => tashkentDayRange(tashkentDateString(new Date(now.getTime() - (n - 1) * 86_400_000))).from;
  const [t, w, m] = await Promise.all([totals(today.from, today.to), totals(days(7), today.to), totals(days(30), today.to)]);
  return { today: t, last7Days: w, last30Days: m };
}

/* ------------------------------------------------------------------ one shop (superadmin) */

const day = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:00' } };
const lineProfit = { $subtract: ['$lines.total', { $round: [{ $multiply: ['$lines.qty', { $ifNull: ['$lines.unitCost', 0] }] }, 0] }] };

/**
 * Statistics of one shop for the platform owner: sales, profit, refunds, declined receipts, goods
 * received, per day / terminal / cashier / product and payment method, compared with the period before.
 */
export async function shopStats(shopId: Types.ObjectId, from: Date | undefined, to: Date) {
  const range = from ? { $gte: from, $lt: to } : { $lt: to };
  const match = { shopId, createdAt: range };
  const prevFrom = from ? new Date(from.getTime() - (to.getTime() - from.getTime())) : undefined;

  const [sum, prev, profit, byDay, dayProfit, byTerminal, byCashier, top, pay, refunds, declined, arrivals, counts, lastSale] = await Promise.all([
    Sale.aggregate([{ $match: match }, { $group: { _id: null, revenue: { $sum: '$total' }, receipts: { $sum: 1 }, discount: { $sum: '$discount' } } }]),
    prevFrom ? Sale.aggregate([{ $match: { shopId, createdAt: { $gte: prevFrom, $lt: from } } }, { $group: { _id: null, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }]) : Promise.resolve([]),
    Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: null, profit: { $sum: lineProfit } } }]),
    Sale.aggregate([{ $match: match }, { $group: { _id: day, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: day, profit: { $sum: lineProfit } } }]),
    Sale.aggregate([{ $match: match }, { $group: { _id: '$terminalId', revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { revenue: -1 } }]),
    Sale.aggregate([{ $match: match }, { $group: { _id: '$cashierId', name: { $last: '$cashierName' }, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { revenue: -1 } }, { $limit: 20 }]),
    Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $last: '$lines.name' }, qty: { $sum: '$lines.qty' }, revenue: { $sum: '$lines.total' } } }, { $sort: { revenue: -1 } }, { $limit: 10 }]),
    Sale.aggregate([{ $match: match }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', amount: { $sum: '$payments.amount' } } }]),
    Refund.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]),
    DeclinedSale.aggregate([{ $match: match }, { $group: { _id: '$reason', total: { $sum: '$total' }, count: { $sum: 1 } } }]),
    GoodsReceipt.aggregate([{ $match: { shopId, status: 'posted', postedAt: range } }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]),
    Promise.all([
      Product.countDocuments({ shopId, isActive: true }),
      User.countDocuments({ shopId, isActive: true }),
      Branch.countDocuments({ shopId }),
      Terminal.countDocuments({ shopId }),
    ]),
    Sale.findOne({ shopId }).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);
  const terms = await Terminal.find({ shopId }).select('name').lean();
  const tn = new Map(terms.map((t) => [String(t._id), t.name]));
  const pd = new Map(dayProfit.map((d: any) => [d._id, d.profit]));
  const revenue = sum[0]?.revenue ?? 0;
  const receipts = sum[0]?.receipts ?? 0;
  const dec = (r: string) => declined.find((d: any) => d._id === r) ?? { total: 0, count: 0 };
  return {
    totals: {
      revenue,
      receipts,
      averageReceipt: receipts ? Math.round(revenue / receipts) : 0,
      discount: sum[0]?.discount ?? 0,
      grossProfit: profit[0]?.profit ?? 0,
      refunds: { total: refunds[0]?.total ?? 0, count: refunds[0]?.count ?? 0 },
      declined: { cleared: dec('cleared'), rejected: dec('rejected') },
      arrivals: { total: arrivals[0]?.total ?? 0, count: arrivals[0]?.count ?? 0 },
    },
    previous: prev[0] ? { revenue: prev[0].revenue, receipts: prev[0].receipts } : null,
    byDay: byDay.map((d: any) => ({ date: d._id, revenue: d.revenue, receipts: d.receipts, profit: pd.get(d._id) ?? 0 })),
    byTerminal: byTerminal.map((t: any) => ({ terminalId: String(t._id), name: tn.get(String(t._id)) ?? '—', revenue: t.revenue, receipts: t.receipts })),
    byCashier: byCashier.map((c: any) => ({ name: c.name ?? '—', revenue: c.revenue, receipts: c.receipts })),
    topProducts: top.map((p: any) => ({ name: p.name ?? '—', qty: p.qty, revenue: p.revenue })),
    payments: pay.map((p: any) => ({ method: p._id, amount: p.amount })),
    counts: { products: counts[0], employees: counts[1], branches: counts[2], terminals: counts[3] },
    lastSaleAt: lastSale?.createdAt ?? null,
  };
}
