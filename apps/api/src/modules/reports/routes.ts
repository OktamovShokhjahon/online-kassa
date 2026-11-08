import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { INVENTORY_REPORTS, dateOnly, formatMoney, inventoryEnabled, objectId, tashkentDateString, tashkentDayRange, translate } from '@kass/shared';
import { forbidden, notFound } from '../../lib/errors';
import { auth, h, ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Category, Product } from '../../models/catalog';
import { Branch, Terminal } from '../../models/core';
import { Customer, Refund, Sale, Shift } from '../../models/sales';
import { Stock, Supplier } from '../../models/stock';
import { findLabelFont, translit } from '../catalog/labels';
import { buildWorkbookBuffer } from '../catalog/spreadsheet';
import { REPORTS, reportByKey } from './defs';
import { branchMatch, buildCtx, canSee, dayOf, exportValue, label, title, type ReportCtx } from './framework';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const baseQuery = z
  .object({
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    branchId: objectId.optional(),
    format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .passthrough();

/* ============================================================================ dashboard */

async function dayMetrics(c: ReportCtx, from: Date, to: Date) {
  const match = { shopId: c.shopId, createdAt: { $gte: from, $lt: to }, ...branchMatch(c) };
  const [s, r, g] = await Promise.all([
    Sale.aggregate([{ $match: match }, { $group: { _id: null, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }]),
    Refund.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Sale.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $group: { _id: null, revenue: { $sum: { $subtract: ['$lines.total', { $ifNull: ['$lines.refundedAmount', 0] }] } }, cost: { $sum: { $multiply: [{ $subtract: ['$lines.qty', { $ifNull: ['$lines.refundedQty', 0] }] }, { $ifNull: ['$lines.unitCost', 0] }] } } } },
    ]),
  ]);
  const revenue = (s[0]?.revenue ?? 0) - (r[0]?.total ?? 0);
  const receipts = s[0]?.receipts ?? 0;
  return { revenue, receipts, averageReceipt: receipts ? Math.round((s[0]?.revenue ?? 0) / receipts) : 0, grossProfit: (g[0]?.revenue ?? 0) - (g[0]?.cost ?? 0) };
}

reportsRouter.get(
  '/dashboard',
  validate({ query: z.object({ branchId: objectId.optional(), period: z.enum(['day', 'week', 'month']).default('day'), from: dateOnly.optional(), to: dateOnly.optional() }) }),
  h(async (req, res) => {
    const a = auth(req);
    if (a.role !== 'shop_admin' && !a.permissions.has('reports.view')) throw forbidden();
    const q = req.query as any;
    const c = buildCtx(req, q);
    const today = tashkentDateString(new Date());
    const dayStart = (offset: number) => tashkentDayRange(tashkentDateString(new Date(Date.now() - offset * 86_400_000)));
    const [t, y, w] = [dayStart(0), dayStart(1), dayStart(7)];
    const [today_, yesterday, lastWeek] = await Promise.all([dayMetrics(c, t.from, t.to), dayMetrics(c, y.from, y.to), dayMetrics(c, w.from, w.to)]);
    const match = { shopId: c.shopId, createdAt: { $gte: c.from, $lt: c.to }, ...branchMatch(c) };
    const bucket = q.period === 'month' ? { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: '+05:00' } } : q.period === 'week' ? { $dateToString: { format: '%G-W%V', date: '$createdAt', timezone: '+05:00' } } : dayOf();
    const lineNet = { $subtract: ['$lines.total', { $ifNull: ['$lines.refundedAmount', 0] }] };
    const netQty = { $subtract: ['$lines.qty', { $ifNull: ['$lines.refundedQty', 0] }] };

    const [chart, byHour, byWeekday, topRevenue, topQty, payments, branches, openShifts, onlineTerminals, pending, lowStock, negativeStock, supplierDebt, customerDebt, catRoll] = await Promise.all([
      Sale.aggregate([{ $match: match }, { $group: { _id: bucket, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: { $hour: { date: '$createdAt', timezone: '+05:00' } }, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: { $dayOfWeek: { date: '$createdAt', timezone: '+05:00' } }, revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, revenue: { $sum: lineNet }, quantity: { $sum: netQty } } }, { $sort: { revenue: -1 } }, { $limit: 10 }]),
      Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', name: { $first: '$lines.name' }, revenue: { $sum: lineNet }, quantity: { $sum: netQty } } }, { $sort: { quantity: -1 } }, { $limit: 10 }]),
      Sale.aggregate([{ $match: match }, { $unwind: '$payments' }, { $group: { _id: '$payments.method', amount: { $sum: '$payments.amount' } } }]),
      Sale.aggregate([{ $match: match }, { $group: { _id: '$branchId', revenue: { $sum: '$total' }, receipts: { $sum: 1 } } }]),
      Shift.countDocuments({ shopId: c.shopId, status: 'open', ...branchMatch(c) }),
      Terminal.countDocuments({ shopId: c.shopId, lastSeenAt: { $gte: new Date(Date.now() - 90_000) }, ...branchMatch(c) }),
      Terminal.aggregate([{ $match: { shopId: c.shopId, ...branchMatch(c) } }, { $group: { _id: null, n: { $sum: { $ifNull: ['$pendingOffline', 0] } } } }]),
      Stock.countDocuments({ shopId: c.shopId, minStock: { $gt: 0 }, $expr: { $lte: ['$quantity', '$minStock'] }, ...branchMatch(c) }),
      Stock.countDocuments({ shopId: c.shopId, quantity: { $lt: 0 }, ...branchMatch(c) }),
      Supplier.aggregate([{ $match: { shopId: c.shopId, balance: { $gt: 0 } } }, { $group: { _id: null, t: { $sum: '$balance' } } }]),
      Customer.aggregate([{ $match: { shopId: c.shopId, debtBalance: { $gt: 0 } } }, { $group: { _id: null, t: { $sum: '$debtBalance' } } }]),
      Sale.aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.productId', revenue: { $sum: lineNet } } }]),
    ]);

    // top categories
    const prods = await Product.find({ shopId: c.shopId, _id: { $in: catRoll.map((r) => r._id) } }).select('categoryId').lean();
    const cats = await Category.find({ shopId: c.shopId }).select('name').lean();
    const cn = new Map(cats.map((x) => [String(x._id), x.name]));
    const pc = new Map(prods.map((p) => [String(p._id), p.categoryId ? String(p.categoryId) : '']));
    const catTotals = new Map<string, number>();
    for (const r of catRoll) catTotals.set(pc.get(String(r._id)) ?? '', (catTotals.get(pc.get(String(r._id)) ?? '') ?? 0) + r.revenue);
    const bn = new Map((await Branch.find({ shopId: c.shopId }).select('name').lean()).map((b) => [String(b._id), b.name]));

    ok(res, {
      currency: c.currency,
      period: { from: c.fromStr, to: c.toStr, bucket: q.period },
      today: today_,
      yesterday,
      sameDayLastWeek: lastWeek,
      chart: chart.map((r) => ({ bucket: r._id, revenue: r.revenue, receipts: r.receipts })),
      byHour: byHour.map((r) => ({ hour: r._id, revenue: r.revenue, receipts: r.receipts })),
      byWeekday: byWeekday.map((r) => ({ weekday: r._id - 1, revenue: r.revenue, receipts: r.receipts })), // 0 = Sunday
      topProductsByRevenue: topRevenue.map((r) => ({ productId: String(r._id), name: r.name, revenue: r.revenue, quantity: Math.round(r.quantity * 1000) / 1000 })),
      topProductsByQuantity: topQty.map((r) => ({ productId: String(r._id), name: r.name, revenue: r.revenue, quantity: Math.round(r.quantity * 1000) / 1000 })),
      topCategories: [...catTotals.entries()].map(([id, revenue]) => ({ name: cn.get(id) ?? '-', revenue })).sort((x, y) => y.revenue - x.revenue).slice(0, 10),
      paymentSplit: payments.map((p) => ({ method: p._id, amount: p.amount })),
      branchComparison: branches.map((b) => ({ branchId: String(b._id), name: bn.get(String(b._id)) ?? '', revenue: b.revenue, receipts: b.receipts })).sort((x, y) => y.revenue - x.revenue),
      live: { openShifts, onlineTerminals, unsentOfflineReceipts: pending[0]?.n ?? 0, lowStock, negativeStock, supplierDebt: supplierDebt[0]?.t ?? 0, customerDebt: customerDebt[0]?.t ?? 0 },
      today_: today,
    });
  }),
);

/* ================================================================================ list */

reportsRouter.get(
  '/',
  h(async (req, res) => {
    const a = auth(req);
    const hidden: readonly string[] = inventoryEnabled() ? [] : INVENTORY_REPORTS;
    ok(res, REPORTS.filter((r) => canSee(req, r.access) && !hidden.includes(r.key)).map((r) => ({ key: r.key, title: translate((a.user.language as any) ?? 'uz', `reports.title.${r.titleKey}`) })));
  }),
);

/* ======================================================================== one report */

function renderPdf(titleText: string, subtitle: string, header: string[], rows: Array<Array<string | number>>, totals: Array<string | number> | null, useUnicode: boolean) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const fontPath = findLabelFont();
  if (fontPath) doc.registerFont('r', fontPath).font('r');
  const t = (s: string | number) => (fontPath || useUnicode ? String(s) : translit(String(s)));
  doc.fontSize(14).text(t(titleText));
  doc.fontSize(8).fillColor('#555').text(t(subtitle)).fillColor('#000').moveDown(0.5);
  const colW = (doc.page.width - 60) / header.length;
  const drawRow = (cells: Array<string | number>, bold = false) => {
    const y = doc.y;
    if (y > doc.page.height - 50) {
      doc.addPage();
    }
    const yy = doc.y;
    cells.forEach((cell, i) => doc.fontSize(8).text(t(cell).slice(0, 40), 30 + i * colW, yy, { width: colW - 4, ellipsis: true, lineBreak: false }));
    doc.y = yy + 12;
    if (bold) doc.moveTo(30, doc.y - 2).lineTo(doc.page.width - 30, doc.y - 2).stroke();
  };
  drawRow(header, true);
  rows.forEach((r) => drawRow(r));
  if (totals) drawRow(totals, true);
  return doc;
}

reportsRouter.get(
  '/:key',
  validate({ query: baseQuery }),
  h(async (req, res) => {
    const def = reportByKey(String(req.params.key));
    if (!def) throw notFound();
    if (!canSee(req, def.access)) throw forbidden();
    const q = req.query as any;
    const c = buildCtx(req, q);
    const result = await def.run(c);
    const format: string = q.format ?? 'json';

    if (format === 'json') {
      const paged = result.total !== undefined;
      const rows = paged ? result.rows : result.rows.slice((c.page - 1) * c.limit, c.page * c.limit);
      return ok(res, { key: def.key, title: title(c.lang, def), currency: c.currency, period: { from: c.fromStr, to: c.toStr }, columns: result.columns.map((x) => ({ ...x, title: label(c.lang, x) })), rows, totals: result.totals, note: result.note }, { page: c.page, limit: c.limit, total: paged ? result.total : result.rows.length });
    }

    // exports contain every row (not just one page), money in major units
    const header = result.columns.map((x) => label(c.lang, x));
    const body = result.rows.slice(0, 50_000).map((r) => result.columns.map((x) => exportValue(x, r[x.key])));
    const totalRow = result.totals ? result.columns.map((x, i) => (i === 0 ? translate(c.lang, 'common.total') : result.totals![x.key] !== undefined ? exportValue(x, result.totals![x.key]) : '')) : null;
    const filename = `${def.key}-${c.fromStr}_${c.toStr}`;
    if (format === 'xlsx') {
      const buf = await buildWorkbookBuffer(title(c.lang, def).slice(0, 30), header, totalRow ? [...body, totalRow as any] : body);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
      return void res.send(buf);
    }
    const sub = `${c.fromStr} - ${c.toStr} · ${translate(c.lang, 'reports.units.currencyNote')} (${c.currency}) · ${formatMoney(100, c.currency, c.lang)}`;
    const doc = renderPdf(title(c.lang, def), sub, header, body, totalRow, false);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    doc.pipe(res);
    doc.end();
  }),
);

