import { tashkentDateString } from '@kass/shared';
import { oid } from '../../lib/util';
import { Category, Price, Product } from '../../models/catalog';
import { AuditLog, Branch, Terminal, User } from '../../models/core';
import { BonusTransaction, Customer, FiscalLog, Refund, Sale, Shift } from '../../models/sales';
import { GoodsReceipt, Stock, StockMovement, Supplier, SupplierPayment, SupplierReturn, WriteOff } from '../../models/stock';
import { computeShiftTotals } from '../pos/shiftService';
import { branchMatch, col, dayOf, type ReportCtx, type ReportDef, type ReportResult } from './framework';

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const salesMatch = (c: ReportCtx) => ({ shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) });

/** Net of refunds: quantity, revenue and cost per product line (reports are by sale date). */
const lineNet = {
  qty: { $subtract: ['$lines.qty', { $ifNull: ['$lines.refundedQty', 0] }] },
  revenue: { $subtract: ['$lines.total', { $ifNull: ['$lines.refundedAmount', 0] }] },
};
const lineCost = { $multiply: [lineNet.qty, { $ifNull: ['$lines.unitCost', 0] }] };

async function productRollup(c: ReportCtx) {
  return Sale.aggregate([
    { $match: salesMatch(c) },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, quantity: { $sum: lineNet.qty }, revenue: { $sum: lineNet.revenue }, cost: { $sum: lineCost } } },
  ]);
}

async function branchNames(c: ReportCtx) {
  const bs = await Branch.find({ shopId: c.shopId }).select('name').lean();
  return new Map(bs.map((b) => [String(b._id), b.name]));
}

const fmtDay = (d: Date | string | undefined | null) => (d ? tashkentDateString(new Date(d)) : '');

/* ================================================================================ sales */
const sales: ReportDef = {
  key: 'sales',
  titleKey: 'sales',
  access: 'manager',
  async run(c) {
    const [days, returns] = await Promise.all([
      Sale.aggregate([{ $match: salesMatch(c) }, { $group: { _id: dayOf(), receipts: { $sum: 1 }, revenue: { $sum: '$total' }, discounts: { $sum: '$discount' } } }, { $sort: { _id: 1 } }]),
      Refund.aggregate([{ $match: { shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) } }, { $group: { _id: dayOf(), returns: { $sum: '$total' } } }]),
    ]);
    const ret = new Map(returns.map((r) => [r._id, r.returns]));
    const dates = [...new Set([...days.map((d) => d._id), ...ret.keys()])].sort();
    const byDay = new Map(days.map((d) => [d._id, d]));
    const rows = dates.map((date) => {
      const d = byDay.get(date);
      const revenue = d?.revenue ?? 0;
      const returns = ret.get(date) ?? 0;
      return { date, receipts: d?.receipts ?? 0, revenue, avgReceipt: d?.receipts ? Math.round(revenue / d.receipts) : 0, discounts: d?.discounts ?? 0, returns, netRevenue: revenue - returns };
    });
    const receipts = sum(rows, 'receipts');
    return {
      columns: [col('date', 'date'), col('receipts', 'number'), col('revenue', 'money'), col('avgReceipt', 'money'), col('discounts', 'money'), col('returns', 'money'), col('netRevenue', 'money')],
      rows,
      totals: { receipts, revenue: sum(rows, 'revenue'), avgReceipt: receipts ? Math.round(sum(rows, 'revenue') / receipts) : 0, discounts: sum(rows, 'discounts'), returns: sum(rows, 'returns'), netRevenue: sum(rows, 'netRevenue') },
    };
  },
};

/* ============================================================================= products */
const products: ReportDef = {
  key: 'products',
  titleKey: 'products',
  access: 'manager',
  async run(c) {
    const agg = await productRollup(c);
    const info = await Product.find({ shopId: c.shopId, _id: { $in: agg.map((a) => a._id) } }).select('sku barcodes').lean();
    const im = new Map(info.map((p) => [String(p._id), p]));
    const rows = agg
      .map((a) => ({ product: a.name, sku: im.get(String(a._id))?.sku ?? '', quantity: a.quantity, revenue: a.revenue, cost: a.cost, grossProfit: a.revenue - a.cost, margin: pct(a.revenue - a.cost, a.revenue) }))
      .sort((x, y) => y.revenue - x.revenue);
    return {
      columns: [col('product'), col('sku'), col('quantity', 'number'), col('revenue', 'money'), col('cost', 'money'), col('grossProfit', 'money'), col('margin', 'percent')],
      rows,
      totals: { quantity: sum(rows, 'quantity'), revenue: sum(rows, 'revenue'), cost: sum(rows, 'cost'), grossProfit: sum(rows, 'grossProfit'), margin: pct(sum(rows, 'grossProfit'), sum(rows, 'revenue')) },
    };
  },
};

/* =========================================================================== categories */
const categories: ReportDef = {
  key: 'categories',
  titleKey: 'categories',
  access: 'manager',
  async run(c) {
    const agg = await productRollup(c);
    const [prods, cats] = await Promise.all([
      Product.find({ shopId: c.shopId, _id: { $in: agg.map((a) => a._id) } }).select('categoryId').lean(),
      Category.find({ shopId: c.shopId }).lean(),
    ]);
    const catOf = new Map(prods.map((p) => [String(p._id), p.categoryId ? String(p.categoryId) : null]));
    const nameOf = new Map(cats.map((x) => [String(x._id), x]));
    const pathName = (id: string | null) => {
      const x = id ? nameOf.get(id) : null;
      if (!x) return '-';
      return [...(x.path ?? []).map((p: any) => nameOf.get(String(p))?.name ?? ''), x.name].filter(Boolean).join(' > ');
    };
    const groups = new Map<string, { quantity: number; revenue: number; cost: number }>();
    for (const a of agg) {
      const k = catOf.get(String(a._id)) ?? '';
      const g = groups.get(k) ?? { quantity: 0, revenue: 0, cost: 0 };
      g.quantity += a.quantity; g.revenue += a.revenue; g.cost += a.cost;
      groups.set(k, g);
    }
    const rows = [...groups.entries()]
      .map(([k, g]) => ({ category: pathName(k || null), quantity: g.quantity, revenue: g.revenue, cost: g.cost, grossProfit: g.revenue - g.cost, margin: pct(g.revenue - g.cost, g.revenue) }))
      .sort((x, y) => y.revenue - x.revenue);
    return {
      columns: [col('category'), col('quantity', 'number'), col('revenue', 'money'), col('cost', 'money'), col('grossProfit', 'money'), col('margin', 'percent')],
      rows,
      totals: { quantity: sum(rows, 'quantity'), revenue: sum(rows, 'revenue'), cost: sum(rows, 'cost'), grossProfit: sum(rows, 'grossProfit') },
    };
  },
};

/* ============================================================================ cashiers */
const cashiers: ReportDef = {
  key: 'cashiers',
  titleKey: 'cashiers',
  access: 'manager',
  async run(c) {
    const [s, r, removed] = await Promise.all([
      Sale.aggregate([{ $match: salesMatch(c) }, { $group: { _id: '$cashierId', name: { $first: '$cashierName' }, receipts: { $sum: 1 }, revenue: { $sum: '$total' }, discounts: { $sum: '$discount' } } }]),
      Refund.aggregate([{ $match: { shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) } }, { $group: { _id: '$cashierId', returns: { $sum: '$total' } } }]),
      AuditLog.aggregate([{ $match: { shopId: c.shopId, action: 'pos.line_removed', createdAt: { $gte: c.from, $lt: c.to } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
    ]);
    const rm = new Map(r.map((x) => [String(x._id), x.returns]));
    const rl = new Map(removed.map((x) => [String(x._id), x.n]));
    const rows = s
      .map((x) => ({ cashier: x.name ?? '-', receipts: x.receipts, revenue: x.revenue, returns: rm.get(String(x._id)) ?? 0, discounts: x.discounts, removedLines: rl.get(String(x._id)) ?? 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    return {
      columns: [col('cashier'), col('receipts', 'number'), col('revenue', 'money'), col('returns', 'money'), col('discounts', 'money'), col('removedLines', 'number')],
      rows,
      totals: { receipts: sum(rows, 'receipts'), revenue: sum(rows, 'revenue'), returns: sum(rows, 'returns'), discounts: sum(rows, 'discounts'), removedLines: sum(rows, 'removedLines') },
    };
  },
};

/* ================================================================================ shifts */
const shifts: ReportDef = {
  key: 'shifts',
  titleKey: 'shifts',
  access: 'manager',
  async run(c) {
    const list = await Shift.find({ shopId: c.shopId, openedAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) }).sort({ openedAt: -1 }).limit(2000).lean();
    const [bn, terms] = await Promise.all([branchNames(c), Terminal.find({ shopId: c.shopId }).select('name').lean()]);
    const tn = new Map(terms.map((t) => [String(t._id), t.name]));
    const rows = [];
    for (const s of list) {
      const t: any = s.status === 'closed' && s.totals ? s.totals : await computeShiftTotals(c.shopId, s as any);
      rows.push({ opened: s.openedAt, closed: s.closedAt ?? '', cashier: s.cashierName ?? '', branch: bn.get(String(s.branchId)) ?? '', terminal: tn.get(String(s.terminalId)) ?? '', receipts: t.receipts, revenue: t.net, openingCash: s.openingCash, expectedCash: s.expectedCash ?? t.expectedCash, countedCash: s.countedCash ?? '', difference: s.difference ?? '' });
    }
    return {
      columns: [col('opened', 'datetime'), col('closed', 'datetime'), col('cashier'), col('branch'), col('terminal'), col('receipts', 'number'), col('revenue', 'money'), col('openingCash', 'money'), col('expectedCash', 'money'), col('countedCash', 'money'), col('difference', 'money')],
      rows,
      totals: { receipts: sum(rows, 'receipts'), revenue: sum(rows, 'revenue'), difference: sum(rows, 'difference') },
    };
  },
};

/* =============================================================================== returns */
const returns: ReportDef = {
  key: 'returns',
  titleKey: 'returns',
  access: 'manager',
  async run(c) {
    const list = await Refund.find({ shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) }).sort({ createdAt: -1 }).limit(5000).lean();
    const users = await User.find({ shopId: c.shopId, _id: { $in: list.map((r) => r.cashierId).filter(Boolean) } }).select('fullName').lean();
    const un = new Map(users.map((u) => [String(u._id), u.fullName]));
    const rows = list.map((r) => ({ date: r.createdAt, number: r.number, saleNumber: r.saleNumber, cashier: un.get(String(r.cashierId)) ?? '', method: r.method, reason: r.reason ?? '', total: r.total }));
    return { columns: [col('date', 'datetime'), col('number'), col('saleNumber'), col('cashier'), col('method'), col('reason'), col('total', 'money')], rows, totals: { total: sum(rows, 'total') } };
  },
};

/* ============================================================================ promotions */
const promotions: ReportDef = {
  key: 'promotions',
  titleKey: 'promotions',
  access: 'admin',
  async run(c) {
    const agg = await Sale.aggregate([
      { $match: salesMatch(c) },
      { $unwind: '$lines' },
      { $match: { 'lines.promotionId': { $exists: true, $ne: null }, 'lines.promoDiscount': { $gt: 0 } } },
      { $group: { _id: '$lines.promotionId', promotion: { $first: '$lines.promotionName' }, quantity: { $sum: '$lines.qty' }, revenue: { $sum: '$lines.total' }, discountAmount: { $sum: '$lines.promoDiscount' }, receipts: { $addToSet: '$_id' } } },
      { $project: { promotion: 1, quantity: 1, revenue: 1, discountAmount: 1, receipts: { $size: '$receipts' } } },
      { $sort: { revenue: -1 } },
    ]);
    const rows = agg.map((a) => ({ promotion: a.promotion ?? String(a._id), receipts: a.receipts, quantity: a.quantity, revenue: a.revenue, discountAmount: a.discountAmount }));
    return { columns: [col('promotion'), col('receipts', 'number'), col('quantity', 'number'), col('revenue', 'money'), col('discountAmount', 'money')], rows, totals: { revenue: sum(rows, 'revenue'), discountAmount: sum(rows, 'discountAmount') } };
  },
};

/* ================================================================================ prices */
const prices: ReportDef = {
  key: 'prices',
  titleKey: 'prices',
  access: 'admin',
  async run(c) {
    const [bn, pr, prods] = await Promise.all([branchNames(c), Price.find({ shopId: c.shopId, ...branchMatch(c) }).lean(), Product.find({ shopId: c.shopId, isActive: true }).select('name sku').lean()]);
    const priceMap = new Map(pr.map((p) => [`${p.productId}:${p.branchId}`, p]));
    const rows: any[] = [];
    const branches = [...bn.keys()].filter((b) => !c.branchIds || c.branchIds.some((x) => String(x) === b));
    for (const p of prods) {
      for (const b of branches) {
        const pr1 = priceMap.get(`${p._id}:${b}`);
        if (c.params.missingOnly === 'true' && pr1) continue;
        rows.push({ product: p.name, sku: p.sku ?? '', branch: bn.get(b), price: pr1 ? pr1.price : '', lastChange: pr1 ? (pr1 as any).updatedAt : '' });
      }
    }
    return { columns: [col('product'), col('sku'), col('branch'), col('price', 'money'), col('lastChange', 'datetime')], rows, note: 'missingOnly=true lists products without a price in a branch' };
  },
};

/* ================================================================================== stock */
const stock: ReportDef = {
  key: 'stock',
  titleKey: 'stock',
  access: 'stock',
  async run(c) {
    const bn = await branchNames(c);
    let balances: Array<{ productId: any; branchId: any; quantity: number }>;
    if (c.params.date) {
      const end = new Date(new Date(`${c.params.date}T00:00:00+05:00`).getTime() + 86_400_000);
      balances = (
        await StockMovement.aggregate([
          { $match: { shopId: c.shopId, createdAt: { $lt: end }, ...branchMatch(c) } },
          { $group: { _id: { p: '$productId', b: '$branchId' }, quantity: { $sum: '$quantity' } } },
        ])
      ).map((r) => ({ productId: r._id.p, branchId: r._id.b, quantity: Math.round(r.quantity * 1000) / 1000 }));
    } else {
      balances = (await Stock.find({ shopId: c.shopId, ...branchMatch(c) }).lean()).map((s) => ({ productId: s.productId, branchId: s.branchId, quantity: s.quantity }));
    }
    balances = balances.filter((b) => b.quantity !== 0);
    const ids = balances.map((b) => b.productId);
    const [prods, st, pr] = await Promise.all([
      Product.find({ shopId: c.shopId, _id: { $in: ids } }).select('name sku').lean(),
      Stock.find({ shopId: c.shopId, productId: { $in: ids } }).select('productId branchId avgCost').lean(),
      Price.find({ shopId: c.shopId, productId: { $in: ids } }).select('productId branchId price').lean(),
    ]);
    const pm = new Map(prods.map((p) => [String(p._id), p]));
    const am = new Map(st.map((s) => [`${s.productId}:${s.branchId}`, s.avgCost as number]));
    const prm = new Map(pr.map((p) => [`${p.productId}:${p.branchId}`, p.price as number]));
    const rows = balances
      .map((b) => {
        const k = `${b.productId}:${b.branchId}`;
        const avg = am.get(k) ?? 0;
        const price = prm.get(k);
        return { product: pm.get(String(b.productId))?.name ?? '', sku: pm.get(String(b.productId))?.sku ?? '', branch: bn.get(String(b.branchId)) ?? '', quantity: b.quantity, valueAtCost: Math.round(b.quantity * avg), price: price ?? '', valueAtPrice: price === undefined ? '' : Math.round(b.quantity * price) };
      })
      .sort((x, y) => x.product.localeCompare(y.product));
    return {
      columns: [col('product'), col('sku'), col('branch'), col('quantity', 'number'), col('valueAtCost', 'money'), col('price', 'money'), col('valueAtPrice', 'money')],
      rows,
      totals: { quantity: sum(rows, 'quantity'), valueAtCost: sum(rows, 'valueAtCost'), valueAtPrice: sum(rows, 'valueAtPrice') },
      note: c.params.date ? 'Historical values use the current average cost and price.' : undefined,
    };
  },
};

/* ========================================================================= stockMovement */
const stockMovement: ReportDef = {
  key: 'stock-movement',
  titleKey: 'stockMovement',
  access: 'stock',
  async run(c) {
    const agg = await StockMovement.aggregate([
      { $match: { shopId: c.shopId, createdAt: { $lt: c.to }, ...branchMatch(c) } },
      {
        $group: {
          _id: { p: '$productId', b: '$branchId' },
          opening: { $sum: { $cond: [{ $lt: ['$createdAt', c.from] }, '$quantity', 0] } },
          incoming: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', c.from] }, { $gt: ['$quantity', 0] }] }, '$quantity', 0] } },
          outgoing: { $sum: { $cond: [{ $and: [{ $gte: ['$createdAt', c.from] }, { $lt: ['$quantity', 0] }] }, '$quantity', 0] } },
        },
      },
    ]);
    const [prods, bn] = await Promise.all([Product.find({ shopId: c.shopId, _id: { $in: agg.map((a) => a._id.p) } }).select('name sku').lean(), branchNames(c)]);
    const pm = new Map(prods.map((p) => [String(p._id), p]));
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const rows = agg
      .filter((a) => a.opening || a.incoming || a.outgoing)
      .map((a) => ({ product: pm.get(String(a._id.p))?.name ?? '', sku: pm.get(String(a._id.p))?.sku ?? '', branch: bn.get(String(a._id.b)) ?? '', opening: r3(a.opening), incoming: r3(a.incoming), outgoing: r3(-a.outgoing), closing: r3(a.opening + a.incoming + a.outgoing) }))
      .sort((x, y) => x.product.localeCompare(y.product));
    return { columns: [col('product'), col('sku'), col('branch'), col('opening', 'number'), col('incoming', 'number'), col('outgoing', 'number'), col('closing', 'number')], rows, totals: { incoming: sum(rows, 'incoming'), outgoing: sum(rows, 'outgoing') } };
  },
};

/* ======================================================================== negativeStock */
const negativeStock: ReportDef = {
  key: 'negative-stock',
  titleKey: 'negativeStock',
  access: 'stock',
  async run(c) {
    const st = await Stock.find({ shopId: c.shopId, quantity: { $lt: 0 }, ...branchMatch(c) }).sort({ quantity: 1 }).lean();
    const [prods, bn] = await Promise.all([Product.find({ shopId: c.shopId, _id: { $in: st.map((s) => s.productId) } }).select('name sku').lean(), branchNames(c)]);
    const pm = new Map(prods.map((p) => [String(p._id), p]));
    const rows = st.map((s) => ({ product: pm.get(String(s.productId))?.name ?? '', sku: pm.get(String(s.productId))?.sku ?? '', branch: bn.get(String(s.branchId)) ?? '', quantity: s.quantity, valueAtCost: Math.round(s.quantity * s.avgCost) }));
    return { columns: [col('product'), col('sku'), col('branch'), col('quantity', 'number'), col('valueAtCost', 'money')], rows, totals: { quantity: sum(rows, 'quantity'), valueAtCost: sum(rows, 'valueAtCost') } };
  },
};

/* ========================================================================== slowMoving */
const slowMoving: ReportDef = {
  key: 'slow-moving',
  titleKey: 'slowMoving',
  access: 'manager',
  async run(c) {
    const days = Math.max(1, Number(c.params.days ?? 30));
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const st = await Stock.find({ shopId: c.shopId, quantity: { $gt: 0 }, ...branchMatch(c) }).lean();
    const last = await Sale.aggregate([{ $match: { shopId: c.shopId, ...branchMatch(c) } }, { $unwind: '$lines' }, { $group: { _id: { p: '$lines.productId', b: '$branchId' }, last: { $max: '$createdAt' } } }]);
    const lm = new Map(last.map((l) => [`${l._id.p}:${l._id.b}`, l.last as Date]));
    const [prods, bn] = await Promise.all([Product.find({ shopId: c.shopId, _id: { $in: st.map((s) => s.productId) } }).select('name sku').lean(), branchNames(c)]);
    const pm = new Map(prods.map((p) => [String(p._id), p]));
    const rows = st
      .map((s) => ({ s, last: lm.get(`${s.productId}:${s.branchId}`) }))
      .filter((x) => !x.last || x.last < cutoff)
      .map(({ s, last }) => ({ product: pm.get(String(s.productId))?.name ?? '', sku: pm.get(String(s.productId))?.sku ?? '', branch: bn.get(String(s.branchId)) ?? '', quantity: s.quantity, valueAtCost: Math.round(s.quantity * s.avgCost), lastSale: last ?? '', daysNoSales: last ? Math.floor((Date.now() - last.getTime()) / 86_400_000) : '' }))
      .sort((a, b) => b.valueAtCost - a.valueAtCost);
    return { columns: [col('product'), col('sku'), col('branch'), col('quantity', 'number'), col('valueAtCost', 'money'), col('lastSale', 'datetime'), col('daysNoSales', 'number')], rows, totals: { valueAtCost: sum(rows, 'valueAtCost') } };
  },
};

/* ============================================================================= purchases */
const purchases: ReportDef = {
  key: 'purchases',
  titleKey: 'purchases',
  access: 'stock',
  async run(c) {
    const filter: Record<string, any> = { shopId: c.shopId, status: 'posted', postedAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) };
    if (c.params.supplierId) filter.supplierId = oid(c.params.supplierId);
    const docs = await GoodsReceipt.find(filter).sort({ postedAt: -1 }).limit(5000).lean();
    const [sups, bn] = await Promise.all([Supplier.find({ shopId: c.shopId, _id: { $in: docs.map((d) => d.supplierId) } }).select('name').lean(), branchNames(c)]);
    const sn = new Map(sups.map((s) => [String(s._id), s.name]));
    const groupBy = c.params.groupBy ?? 'document';
    if (groupBy === 'product') {
      const m = new Map<string, { quantity: number; total: number }>();
      for (const d of docs) for (const l of d.lines) { const g = m.get(String(l.productId)) ?? { quantity: 0, total: 0 }; g.quantity += l.qty; g.total += Math.round(l.qty * l.cost); m.set(String(l.productId), g); }
      const prods = await Product.find({ shopId: c.shopId, _id: { $in: [...m.keys()] } }).select('name').lean();
      const pn = new Map(prods.map((p) => [String(p._id), p.name]));
      const rows = [...m.entries()].map(([id, g]) => ({ product: pn.get(id) ?? '', quantity: g.quantity, total: g.total, price: g.quantity ? Math.round(g.total / g.quantity) : 0 })).sort((a, b) => b.total - a.total);
      return { columns: [col('product'), col('quantity', 'number'), col('price', 'money'), col('total', 'money')], rows, totals: { total: sum(rows, 'total') } };
    }
    if (groupBy === 'supplier') {
      const m = new Map<string, { n: number; total: number }>();
      for (const d of docs) { const g = m.get(String(d.supplierId)) ?? { n: 0, total: 0 }; g.n++; g.total += d.total; m.set(String(d.supplierId), g); }
      const rows = [...m.entries()].map(([id, g]) => ({ supplier: sn.get(id) ?? '', receipts: g.n, total: g.total })).sort((a, b) => b.total - a.total);
      return { columns: [col('supplier'), col('receipts', 'number'), col('total', 'money')], rows, totals: { total: sum(rows, 'total') } };
    }
    const rows = docs.map((d) => ({ date: d.postedAt, number: d.number, supplier: sn.get(String(d.supplierId)) ?? '', invoice: d.invoiceNo ?? '', branch: bn.get(String(d.branchId)) ?? '', total: d.total }));
    return { columns: [col('date', 'datetime'), col('number'), col('supplier'), col('invoice'), col('branch'), col('total', 'money')], rows, totals: { total: sum(rows, 'total') } };
  },
};

/* ============================================================================== suppliers */
const suppliers: ReportDef = {
  key: 'suppliers',
  titleKey: 'suppliers',
  access: 'admin',
  async run(c) {
    const sups = await Supplier.find({ shopId: c.shopId }).sort({ name: 1 }).lean();
    const [receipts, payments, returns] = await Promise.all([
      GoodsReceipt.find({ shopId: c.shopId, status: { $in: ['posted'] } }).select('supplierId total postedAt').sort({ postedAt: 1 }).lean(),
      SupplierPayment.aggregate([{ $match: { shopId: c.shopId } }, { $group: { _id: '$supplierId', total: { $sum: '$amount' } } }]),
      SupplierReturn.aggregate([{ $match: { shopId: c.shopId, status: 'posted' } }, { $group: { _id: '$supplierId', total: { $sum: '$total' } } }]),
    ]);
    const pay = new Map(payments.map((p) => [String(p._id), p.total as number]));
    const ret = new Map(returns.map((p) => [String(p._id), p.total as number]));
    const now = Date.now();
    const rows = sups.map((s) => {
      // Payments and returns settle the oldest purchases first; what is left past the term is overdue.
      let credit = (pay.get(String(s._id)) ?? 0) + (ret.get(String(s._id)) ?? 0);
      let overdue = 0;
      let purchased = 0;
      for (const r of receipts.filter((x) => String(x.supplierId) === String(s._id))) {
        purchased += r.total;
        const used = Math.min(credit, r.total);
        credit -= used;
        const open = r.total - used;
        if (open > 0 && r.postedAt && now > r.postedAt.getTime() + (s.paymentTermDays ?? 0) * 86_400_000) overdue += open;
      }
      return { supplier: s.name, paymentTerm: s.paymentTermDays ?? 0, purchases: purchased, payments: pay.get(String(s._id)) ?? 0, balance: s.balance, overdue };
    });
    return { columns: [col('supplier'), col('paymentTerm', 'number'), col('purchases', 'money'), col('payments', 'money'), col('balance', 'money'), col('overdue', 'money')], rows, totals: { balance: sum(rows, 'balance'), overdue: sum(rows, 'overdue') } };
  },
};

/* ========================================================================= customerDebts */
const customerDebts: ReportDef = {
  key: 'customer-debts',
  titleKey: 'customerDebts',
  access: 'manager',
  async run(c) {
    const list = await Customer.find({ shopId: c.shopId, debtBalance: { $gt: 0 } }).sort({ debtBalance: -1 }).lean();
    const now = Date.now();
    const rows = list.map((x) => {
      const age = x.debtSince ? Math.floor((now - x.debtSince.getTime()) / 86_400_000) : 0;
      return { customer: x.fullName, phone: x.phone, debt: x.debtBalance, age0: age <= 30 ? x.debtBalance : 0, age31: age > 30 && age <= 60 ? x.debtBalance : 0, age60: age > 60 ? x.debtBalance : 0 };
    });
    return { columns: [col('customer'), col('phone'), col('debt', 'money'), col('age0', 'money'), col('age31', 'money'), col('age60', 'money')], rows, totals: { debt: sum(rows, 'debt'), age0: sum(rows, 'age0'), age31: sum(rows, 'age31'), age60: sum(rows, 'age60') }, note: 'Ageing counts from the date the oldest unpaid debt started.' };
  },
};

/* ================================================================================ loyalty */
const loyalty: ReportDef = {
  key: 'loyalty',
  titleKey: 'loyalty',
  access: 'admin',
  async run(c) {
    const agg = await BonusTransaction.aggregate([
      { $match: { shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to } } },
      { $group: { _id: '$customerId', earned: { $sum: { $cond: [{ $eq: ['$type', 'earn'] }, '$amount', 0] } }, spent: { $sum: { $cond: [{ $eq: ['$type', 'spend'] }, { $multiply: ['$amount', -1] }, 0] } } } },
    ]);
    const custs = await Customer.find({ shopId: c.shopId, _id: { $in: agg.map((a) => a._id) } }).select('fullName phone bonusBalance').lean();
    const cm = new Map(custs.map((x) => [String(x._id), x]));
    const rows = agg.map((a) => ({ customer: cm.get(String(a._id))?.fullName ?? '', phone: cm.get(String(a._id))?.phone ?? '', bonusEarned: a.earned, bonusSpent: a.spent, bonusBalance: cm.get(String(a._id))?.bonusBalance ?? 0 })).sort((x, y) => y.bonusEarned - x.bonusEarned);
    return { columns: [col('customer'), col('phone'), col('bonusEarned', 'money'), col('bonusSpent', 'money'), col('bonusBalance', 'money')], rows, totals: { bonusEarned: sum(rows, 'bonusEarned'), bonusSpent: sum(rows, 'bonusSpent') } };
  },
};

/* ================================================================================= profit */
const profit: ReportDef = {
  key: 'profit',
  titleKey: 'profit',
  access: 'admin',
  async run(c) {
    const [days, wo] = await Promise.all([
      Sale.aggregate([{ $match: salesMatch(c) }, { $unwind: '$lines' }, { $group: { _id: dayOf(), revenue: { $sum: lineNet.revenue }, cost: { $sum: lineCost } } }, { $sort: { _id: 1 } }]),
      WriteOff.aggregate([{ $match: { shopId: c.shopId, status: 'posted', postedAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) } }, { $group: { _id: dayOf('$postedAt'), total: { $sum: '$total' } } }]),
    ]);
    const wm = new Map(wo.map((w) => [w._id, w.total as number]));
    const dates = [...new Set([...days.map((d) => d._id), ...wm.keys()])].sort();
    const dm = new Map(days.map((d) => [d._id, d]));
    const rows = dates.map((date) => {
      const d = dm.get(date);
      const revenue = d?.revenue ?? 0;
      const cost = d?.cost ?? 0;
      const writeOffs = wm.get(date) ?? 0;
      return { date, netRevenue: revenue, cost, writeOffs, grossProfit: revenue - cost - writeOffs, margin: pct(revenue - cost - writeOffs, revenue) };
    });
    const r = sum(rows, 'netRevenue');
    return { columns: [col('date', 'date'), col('netRevenue', 'money'), col('cost', 'money'), col('writeOffs', 'money'), col('grossProfit', 'money'), col('margin', 'percent')], rows, totals: { netRevenue: r, cost: sum(rows, 'cost'), writeOffs: sum(rows, 'writeOffs'), grossProfit: sum(rows, 'grossProfit'), margin: pct(sum(rows, 'grossProfit'), r) }, note: 'Revenue − cost of goods sold − write-offs. Sales with negative stock use the last known average cost.' };
  },
};

/* ================================================================================= fiscal */
const fiscal: ReportDef = {
  key: 'fiscal',
  titleKey: 'fiscal',
  access: 'admin',
  async run(c) {
    const [days, errs] = await Promise.all([
      Sale.aggregate([{ $match: salesMatch(c) }, { $group: { _id: dayOf(), receipts: { $sum: 1 }, fiscalized: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$fiscal.sign', ''] } }, 0] }, 1, 0] } } } }, { $sort: { _id: 1 } }]),
      FiscalLog.aggregate([{ $match: { shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, status: { $in: ['error', 'timeout'] } } }, { $group: { _id: dayOf(), n: { $sum: 1 } } }]),
    ]);
    const em = new Map(errs.map((e) => [e._id, e.n as number]));
    const dates = [...new Set([...days.map((d) => d._id), ...em.keys()])].sort();
    const dm = new Map(days.map((d) => [d._id, d]));
    const rows = dates.map((date) => ({ date, receipts: dm.get(date)?.receipts ?? 0, fiscalized: dm.get(date)?.fiscalized ?? 0, notFiscalized: (dm.get(date)?.receipts ?? 0) - (dm.get(date)?.fiscalized ?? 0), fiscalErrors: em.get(date) ?? 0 }));
    return { columns: [col('date', 'date'), col('receipts', 'number'), col('fiscalized', 'number'), col('notFiscalized', 'number'), col('fiscalErrors', 'number')], rows, totals: { receipts: sum(rows, 'receipts'), fiscalized: sum(rows, 'fiscalized'), notFiscalized: sum(rows, 'notFiscalized'), fiscalErrors: sum(rows, 'fiscalErrors') } };
  },
};

/* ============================================================================ offlineSync */
const offlineSync: ReportDef = {
  key: 'offline-sync',
  titleKey: 'offlineSync',
  access: 'admin',
  async run(c) {
    const list = await Sale.find({ ...salesMatch(c), isOffline: true }).sort({ createdAt: -1 }).limit(5000).lean();
    const bn = await branchNames(c);
    const rows = list.map((s) => ({ number: s.number, localNumber: s.localNumber ?? '', branch: bn.get(String(s.branchId)) ?? '', madeAt: s.createdAt, syncedAt: s.syncedAt ?? '', delayMin: s.syncedAt ? Math.round((s.syncedAt.getTime() - s.createdAt.getTime()) / 60000) : '', total: s.total, conflicts: (s.conflicts ?? []).length }));
    return { columns: [col('number'), col('localNumber'), col('branch'), col('madeAt', 'datetime'), col('syncedAt', 'datetime'), col('delayMin', 'number'), col('total', 'money'), col('conflicts', 'number')], rows, totals: { total: sum(rows, 'total'), conflicts: sum(rows, 'conflicts') } };
  },
};

/* ================================================================================ journal */
const journal: ReportDef = {
  key: 'journal',
  titleKey: 'journal',
  access: 'manager',
  async run(c) {
    const f: Record<string, any> = { ...salesMatch(c) };
    if (c.params.number) f.number = new RegExp('^' + String(c.params.number).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (c.params.cashierId) f.cashierId = oid(c.params.cashierId);
    if (c.params.customerId) f.customerId = oid(c.params.customerId);
    if (c.params.productId) f['lines.productId'] = oid(c.params.productId);
    const [list, total] = await Promise.all([Sale.find(f).sort({ createdAt: -1 }).skip((c.page - 1) * c.limit).limit(c.limit).lean(), Sale.countDocuments(f)]);
    const [bn, custs] = await Promise.all([branchNames(c), Customer.find({ shopId: c.shopId, _id: { $in: list.map((s) => s.customerId).filter(Boolean) } }).select('fullName').lean()]);
    const cn = new Map(custs.map((x) => [String(x._id), x.fullName]));
    const rows = list.map((s) => ({ date: s.createdAt, number: s.number, branch: bn.get(String(s.branchId)) ?? '', cashier: s.cashierName ?? '', customer: s.customerId ? cn.get(String(s.customerId)) ?? '' : '', discounts: s.discount, total: s.total, status: s.status }));
    return { columns: [col('date', 'datetime'), col('number'), col('branch'), col('cashier'), col('customer'), col('discounts', 'money'), col('total', 'money'), col('status')], rows, total };
  },
};

export const REPORTS: ReportDef[] = [sales, products, categories, cashiers, shifts, returns, promotions, prices, stock, stockMovement, negativeStock, slowMoving, purchases, suppliers, customerDebts, loyalty, profit, fiscal, offlineSync, journal];
export const reportByKey = (key: string) => REPORTS.find((r) => r.key === key);
export type { ReportResult };
export { fmtDay };
