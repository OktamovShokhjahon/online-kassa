import type { Types } from 'mongoose';
import type { HistoryType } from '@kass/shared';
import { escapeRegex } from '../../lib/util';
import { Branch, Terminal } from '../../models/core';
import { CashOperation, DeclinedSale, Refund, Sale, Shift } from '../../models/sales';
import { GoodsReceipt, Supplier } from '../../models/stock';
import { Product } from '../../models/catalog';

/** One row of the history: a sale, a declined receipt, a refund, an arrival, a shift event or cash in/out. */
export interface HistoryItem {
  id: string;
  type: HistoryType;
  /** shift: 'open' | 'close'; cash: 'in' | 'out'; declined: 'cleared' | 'rejected'; sale/arrival: document status. */
  kind?: string;
  at: Date;
  number?: string;
  amount: number;
  method?: string;
  status?: string;
  branchId?: string;
  branchName?: string;
  terminalId?: string;
  terminalName?: string;
  cashierName?: string;
  supplierName?: string | null;
  items: Array<{ name: string; qty: number }>;
  /** Error code of a rejected receipt, reason of a refund / cancelled arrival, cash comment, shift note. */
  note?: string;
  isOffline?: boolean;
}

export interface HistoryFilter {
  shopId: Types.ObjectId;
  type?: HistoryType;
  from?: Date;
  to?: Date;
  /** Restrict to these branches (staff without access to every branch). */
  branchIds?: Types.ObjectId[];
  terminalId?: Types.ObjectId | string;
  q?: string;
  page: number;
  limit: number;
}

export interface HistoryResult {
  items: HistoryItem[];
  total: number;
  /** Count and amount per type for the whole filter (without the type filter itself). */
  summary: Record<HistoryType, { count: number; amount: number }>;
}

const MAX_WINDOW = 2000;

/**
 * Merges several collections into one time-ordered feed. Each source is read newest-first up to
 * page * limit rows, so any page is exact while staying cheap for the first pages people look at.
 */
export async function historyFeed(f: HistoryFilter): Promise<HistoryResult> {
  const window = Math.min(f.page * f.limit, MAX_WINDOW);
  const range = (field: string) => (f.from || f.to ? { [field]: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } } : {});
  const branch = f.branchIds ? { branchId: { $in: f.branchIds } } : {};
  const terminal = f.terminalId ? { terminalId: f.terminalId } : {};
  const rx = f.q ? new RegExp(escapeRegex(f.q), 'i') : null;
  const base = { shopId: f.shopId, ...branch };

  // cash operations only know their shift: resolve the shifts of the terminal / branches first
  let cashShift: Record<string, unknown> = {};
  if (f.terminalId || f.branchIds) {
    const ids = await Shift.find({ shopId: f.shopId, ...branch, ...terminal }).select('_id').lean();
    cashShift = { shiftId: { $in: ids.map((s) => s._id) } };
  }

  const q = {
    sale: { ...base, ...terminal, ...range('createdAt'), ...(rx ? { $or: [{ number: rx }, { localNumber: rx }, { 'lines.name': rx }, { cashierName: rx }] } : {}) },
    declined: { ...base, ...terminal, ...range('createdAt'), ...(rx ? { $or: [{ 'lines.name': rx }, { errorCode: rx }, { cashierName: rx }] } : {}) },
    refund: { ...base, ...terminal, ...range('createdAt'), ...(rx ? { $or: [{ number: rx }, { saleNumber: rx }, { 'lines.name': rx }, { reason: rx }] } : {}) },
    // arrivals belong to a branch, not a terminal; a terminal filter keeps the arrivals of its branch
    arrival: { ...base, status: { $in: ['posted', 'cancelled'] }, postedAt: { $exists: true }, ...range('postedAt'), ...(rx ? { $or: [{ number: rx }, { invoiceNo: rx }, { note: rx }] } : {}) },
    shiftOpen: { ...base, ...terminal, ...range('openedAt'), ...(rx ? { cashierName: rx } : {}) },
    shiftClose: { ...base, ...terminal, status: 'closed', ...range('closedAt'), ...(rx ? { cashierName: rx } : {}) },
    cash: { shopId: f.shopId, ...cashShift, ...range('createdAt'), ...(rx ? { comment: rx } : {}) },
  };
  if (f.terminalId) {
    const t = await Terminal.findOne({ shopId: f.shopId, _id: f.terminalId }).select('branchId').lean();
    (q.arrival as any).branchId = t?.branchId ?? null;
  }

  const want = (t: HistoryType) => !f.type || f.type === t;
  const none = Promise.resolve([] as any[]);
  const [sales, declined, refunds, arrivals, opens, closes, cash] = await Promise.all([
    want('sale') ? Sale.find(q.sale).sort({ createdAt: -1 }).limit(window).select('number localNumber lines.name lines.qty total payments status branchId terminalId cashierName createdAt isOffline refundedTotal').lean() : none,
    want('declined') ? DeclinedSale.find(q.declined).sort({ createdAt: -1 }).limit(window).lean() : none,
    want('refund') ? Refund.find(q.refund).sort({ createdAt: -1 }).limit(window).lean() : none,
    want('arrival') ? GoodsReceipt.find(q.arrival).sort({ postedAt: -1 }).limit(window).lean() : none,
    want('shift') ? Shift.find(q.shiftOpen).sort({ openedAt: -1 }).limit(window).lean() : none,
    want('shift') ? Shift.find(q.shiftClose).sort({ closedAt: -1 }).limit(window).lean() : none,
    want('cash') ? CashOperation.find(q.cash).sort({ createdAt: -1 }).limit(window).lean() : none,
  ]);

  // summary over every type (the chips above the list), independent of the type filter
  const sum = async (model: any, match: any, amount: string | null) => {
    const r = await model.aggregate([{ $match: match }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: amount ? `$${amount}` : 0 } } }]);
    return { count: r[0]?.count ?? 0, amount: r[0]?.amount ?? 0 };
  };
  const [sSale, sDecl, sRef, sArr, sOpen, sClose, sCash] = await Promise.all([
    sum(Sale, q.sale, 'total'),
    sum(DeclinedSale, q.declined, 'total'),
    sum(Refund, q.refund, 'total'),
    sum(GoodsReceipt, { ...q.arrival, status: 'posted' }, 'total').then(async (posted) => ({ count: await GoodsReceipt.countDocuments(q.arrival), amount: posted.amount })),
    sum(Shift, q.shiftOpen, null),
    sum(Shift, q.shiftClose, null),
    sum(CashOperation, q.cash, 'amount'),
  ]);
  const summary: HistoryResult['summary'] = {
    sale: sSale,
    declined: sDecl,
    refund: sRef,
    arrival: sArr,
    shift: { count: sOpen.count + sClose.count, amount: 0 },
    cash: sCash,
  };

  // names of branches, terminals, suppliers and arrival products
  const [branches, terminals] = await Promise.all([
    Branch.find({ shopId: f.shopId }).select('name').lean(),
    Terminal.find({ shopId: f.shopId }).select('name branchId').lean(),
  ]);
  const bn = new Map(branches.map((b) => [String(b._id), b.name]));
  const tn = new Map(terminals.map((t) => [String(t._id), t.name]));
  const supIds = [...new Set(arrivals.map((a: any) => a.supplierId).filter(Boolean).map(String))];
  const prodIds = [...new Set(arrivals.flatMap((a: any) => a.lines.map((l: any) => String(l.productId))))];
  const [sups, prods] = await Promise.all([
    supIds.length ? Supplier.find({ shopId: f.shopId, _id: { $in: supIds } }).select('name').lean() : [],
    prodIds.length ? Product.find({ shopId: f.shopId, _id: { $in: prodIds } }).select('name').lean() : [],
  ]);
  const sn = new Map((sups as any[]).map((s) => [String(s._id), s.name]));
  const pn = new Map((prods as any[]).map((p) => [String(p._id), p.name]));
  const shiftTerminal = new Map<string, any>();
  if (cash.length) {
    const sh = await Shift.find({ shopId: f.shopId, _id: { $in: cash.map((c: any) => c.shiftId) } }).select('terminalId branchId cashierName').lean();
    for (const s of sh) shiftTerminal.set(String(s._id), s);
  }
  const where = (branchId?: any, terminalId?: any) => ({
    branchId: branchId ? String(branchId) : undefined,
    branchName: branchId ? bn.get(String(branchId)) : undefined,
    terminalId: terminalId ? String(terminalId) : undefined,
    terminalName: terminalId ? tn.get(String(terminalId)) : undefined,
  });

  const items: HistoryItem[] = [
    ...sales.map((s: any): HistoryItem => ({
      id: String(s._id), type: 'sale', kind: s.status, at: s.createdAt, number: s.number, amount: s.total, status: s.status,
      method: s.payments?.length > 1 ? 'mixed' : s.payments?.[0]?.method, cashierName: s.cashierName, isOffline: s.isOffline,
      items: s.lines.map((l: any) => ({ name: l.name, qty: l.qty })), ...where(s.branchId, s.terminalId),
    })),
    ...declined.map((d: any): HistoryItem => ({
      id: String(d._id), type: 'declined', kind: d.reason, at: d.createdAt, amount: d.total, method: d.method, cashierName: d.cashierName,
      note: d.errorCode, items: d.lines.map((l: any) => ({ name: l.name, qty: l.qty })), ...where(d.branchId, d.terminalId),
    })),
    ...refunds.map((r: any): HistoryItem => ({
      id: String(r._id), type: 'refund', at: r.createdAt, number: r.number, amount: r.total, method: r.method, note: r.reason,
      items: r.lines.map((l: any) => ({ name: l.name, qty: l.qty })), ...where(r.branchId, r.terminalId),
      cashierName: undefined, status: r.saleNumber,
    })),
    ...arrivals.map((a: any): HistoryItem => ({
      id: String(a._id), type: 'arrival', kind: a.status, at: a.postedAt, number: a.number, amount: a.total, status: a.status,
      supplierName: a.supplierId ? sn.get(String(a.supplierId)) ?? '' : null, note: a.status === 'cancelled' ? a.cancelReason : a.note,
      items: a.lines.map((l: any) => ({ name: pn.get(String(l.productId)) ?? '', qty: l.qty })), ...where(a.branchId),
    })),
    ...opens.map((s: any): HistoryItem => ({
      id: `${s._id}:open`, type: 'shift', kind: 'open', at: s.openedAt, amount: s.openingCash ?? 0, cashierName: s.cashierName,
      note: s.autoManaged ? 'auto' : undefined, items: [], ...where(s.branchId, s.terminalId),
    })),
    ...closes.map((s: any): HistoryItem => ({
      id: `${s._id}:close`, type: 'shift', kind: 'close', at: s.closedAt, amount: s.totals?.net ?? 0, cashierName: s.cashierName,
      note: s.note, items: [], ...where(s.branchId, s.terminalId),
    })),
    ...cash.map((c: any): HistoryItem => {
      const sh = shiftTerminal.get(String(c.shiftId));
      return { id: String(c._id), type: 'cash', kind: c.type, at: c.createdAt, amount: c.amount, note: c.comment, cashierName: sh?.cashierName, items: [], ...where(sh?.branchId, sh?.terminalId) };
    }),
  ];
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const total = f.type ? summary[f.type].count : Object.values(summary).reduce((s, x) => s + x.count, 0);
  return { items: items.slice((f.page - 1) * f.limit, f.page * f.limit), total, summary };
}
