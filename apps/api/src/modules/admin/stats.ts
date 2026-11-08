import { tashkentDateString, tashkentDayRange } from '@kass/shared';
import { Sale } from '../../models/sales';

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
