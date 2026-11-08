import { Router, type Request } from 'express';
import type { Model, Types } from 'mongoose';
import { z } from 'zod';
import {
  cancelSchema,
  documentListQuerySchema,
  goodsReceiptInputSchema,
  goodsReceiptUpdateSchema,
  objectId,
  stockCountInputSchema,
  stockCountLinesSchema,
  stockCountPostSchema,
  supplierReturnInputSchema,
  transferInputSchema,
  transferReceiveSchema,
  writeOffInputSchema,
} from '@kass/shared';
import { withTx } from '../../db/connect';
import { audit } from '../../lib/audit';
import { nextNumber } from '../../lib/counters';
import { badRequest, forbidden, notFound, unprocessable } from '../../lib/errors';
import { events } from '../../lib/events';
import { auth, created, h, ok, repo, shopId } from '../../lib/http';
import { escapeRegex, oid } from '../../lib/util';
import { assertBranchAccess, authenticate, canAccessBranch, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Category, Product } from '../../models/catalog';
import { Branch } from '../../models/core';
import {
  GoodsReceipt,
  Stock,
  StockCount,
  Supplier,
  SupplierReturn,
  Transfer,
  WriteOff,
} from '../../models/stock';
import { categoryWithDescendants } from '../catalog/categories';
import { StockTx, lockCurrency } from './stockService';

const idParams = validate({ params: z.object({ id: objectId }) });
const sum = (lines: Array<{ qty: number; cost?: number }>) => lines.reduce((s, l) => s + Math.round(l.qty * (l.cost ?? 0)), 0);

/* ----------------------------------------------------------------------------- helpers */

async function assertBranch(req: Request, branchId: string) {
  if (!(await repo(req, Branch).exists({ _id: branchId }))) throw notFound('BRANCH_NOT_FOUND');
  assertBranchAccess(req, branchId);
}

async function assertSupplier(req: Request, supplierId: string) {
  if (!(await repo(req, Supplier).exists({ _id: supplierId }))) throw notFound('SUPPLIER_NOT_FOUND');
}

async function assertProducts(req: Request, ids: string[]) {
  const unique = [...new Set(ids)];
  if ((await repo(req, Product).count({ _id: { $in: unique } })) !== unique.length) throw notFound('PRODUCT_NOT_FOUND');
}

/**
 * Atomically moves a document from one status to another. Only one concurrent request can win,
 * which makes posting/cancelling idempotent-safe; losers get a precise error.
 */
async function claim<T>(model: Model<any>, req: Request, id: string, from: string[], set: Record<string, unknown>, session: any): Promise<T> {
  const sid = shopId(req);
  const doc = await model.findOneAndUpdate({ _id: id, shopId: sid, status: { $in: from } }, { $set: set }, { new: true, session });
  if (doc) return doc as T;
  const existing = await model.findOne({ _id: id, shopId: sid }).select('status').session(session).lean();
  if (!existing) throw notFound();
  const status = (existing as any).status;
  throw unprocessable(status === 'posted' || status === 'received' ? 'DOCUMENT_POSTED' : status === 'cancelled' ? 'DOCUMENT_CANCELLED' : 'INVALID_STATE');
}

function listFilter(req: Request, q: z.infer<typeof documentListQuerySchema>, branchField: string | string[] = 'branchId') {
  const a = auth(req);
  const filter: Record<string, any> = {};
  const fields = Array.isArray(branchField) ? branchField : [branchField];
  const and: any[] = [];
  if (a.role !== 'shop_admin') and.push({ $or: fields.map((f) => ({ [f]: { $in: a.branchIds } })) });
  if (q.branchId) and.push({ $or: fields.map((f) => ({ [f]: oid(q.branchId!) })) });
  if (and.length) filter.$and = and;
  if (q.supplierId) filter.supplierId = q.supplierId;
  if (q.status) filter.status = q.status;
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ number: rx }, { invoiceNo: rx }];
  }
  return filter;
}

async function getDoc(req: Request, model: Model<any>, id: string, branchFields: string[] = ['branchId']) {
  const doc = await repo(req, model).findById(id);
  if (!doc) throw notFound();
  const a = auth(req);
  if (a.role !== 'shop_admin' && !branchFields.some((f) => canAccessBranch(a, (doc as any)[f]))) throw notFound();
  return doc as any;
}

async function withNames(req: Request, docs: any[]) {
  const ids = [...new Set(docs.flatMap((d) => (d.lines ?? []).map((l: any) => String(l.productId))))];
  if (!ids.length) return docs.map((d) => d.toJSON());
  const products = await repo(req, Product).find({ _id: { $in: ids } }).select('name barcodes unit').lean();
  const map = new Map(products.map((p) => [String(p._id), p]));
  return docs.map((d) => {
    const j = d.toJSON();
    j.lines = j.lines.map((l: any) => ({ ...l, productName: map.get(String(l.productId))?.name, barcode: map.get(String(l.productId))?.barcodes?.[0], unit: map.get(String(l.productId))?.unit }));
    return j;
  });
}

const flush = (list: any[]) => events.emitAll(list);
const VIEW = ['stock.view', 'stock.receipt', 'stock.transfer', 'stock.writeoff', 'stock.count'];

/* ======================================================================== goods receipts */

export const goodsReceiptsRouter = Router();
goodsReceiptsRouter.use(authenticate);

async function postReceipt(req: Request, id: string) {
  const a = auth(req);
  const sid = shopId(req);
  let tx!: StockTx;
  const doc = await withTx(async (session) => {
    const r = await claim<any>(GoodsReceipt, req, id, ['draft'], { status: 'posted', postedAt: new Date() }, session);
    assertBranchAccess(req, r.branchId);
    tx = await StockTx.forShop(sid, session, a.userId);
    for (const l of r.lines) {
      await tx.move({ branchId: r.branchId, productId: l.productId, type: 'goods_receipt', quantity: l.qty, unitCost: l.cost, docType: 'goods_receipt', docId: r._id, docNumber: r.number });
    }
    await Supplier.updateOne({ _id: r.supplierId, shopId: sid }, { $inc: { balance: r.total } }, { session });
    await lockCurrency(sid, session);
    await audit(req, { action: 'goods_receipt.posted', entity: 'goods_receipt', entityId: r._id, meta: { number: r.number, total: r.total } }, session);
    return r;
  });
  flush([...tx.events, { name: 'goods_receipt.posted', shopId: sid, data: { id: String(doc._id), number: doc.number, branchId: String(doc.branchId), total: doc.total } }]);
  return doc;
}

goodsReceiptsRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: documentListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, GoodsReceipt).paginate(listFilter(req, q), { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => d.toJSON()), meta);
  }),
);

goodsReceiptsRouter.post(
  '/',
  requirePermission('stock.receipt'),
  validate({ body: goodsReceiptInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const { post, ...b } = req.body as z.infer<typeof goodsReceiptInputSchema>;
    await assertBranch(req, b.branchId);
    await assertSupplier(req, b.supplierId);
    await assertProducts(req, b.lines.map((l) => l.productId));
    const number = await nextNumber(shopId(req), 'goodsReceipt', 'GR');
    const doc = await repo(req, GoodsReceipt).create({ ...b, number, total: sum(b.lines), createdBy: a.userId, status: 'draft' });
    await audit(req, { action: 'goods_receipt.created', entity: 'goods_receipt', entityId: doc._id, meta: { number } });
    const final = post ? await postReceipt(req, String(doc._id)) : doc;
    created(res, (await withNames(req, [final]))[0]);
  }),
);

goodsReceiptsRouter.get(
  '/:id',
  idParams,
  requirePermission(...VIEW),
  h(async (req, res) => ok(res, (await withNames(req, [await getDoc(req, GoodsReceipt, req.params.id)]))[0])),
);

goodsReceiptsRouter.patch(
  '/:id',
  idParams,
  requirePermission('stock.receipt'),
  validate({ body: goodsReceiptUpdateSchema }),
  h(async (req, res) => {
    const doc = await getDoc(req, GoodsReceipt, req.params.id);
    if (doc.status !== 'draft') throw unprocessable('DOCUMENT_EDIT_FORBIDDEN');
    const b = req.body as z.infer<typeof goodsReceiptUpdateSchema>;
    if (b.branchId) await assertBranch(req, b.branchId);
    if (b.supplierId) await assertSupplier(req, b.supplierId);
    if (b.lines) {
      await assertProducts(req, b.lines.map((l) => l.productId));
      doc.lines = b.lines;
      doc.total = sum(b.lines);
    }
    const { lines, ...rest } = b;
    Object.assign(doc, rest);
    await doc.save();
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

goodsReceiptsRouter.post(
  '/:id/post',
  idParams,
  requirePermission('stock.receipt'),
  h(async (req, res) => {
    await getDoc(req, GoodsReceipt, req.params.id);
    ok(res, (await withNames(req, [await postReceipt(req, req.params.id)]))[0]);
  }),
);

/** Draft: simply cancelled. Posted: cancelled by a reversing movement with a reason. */
goodsReceiptsRouter.post(
  '/:id/cancel',
  idParams,
  requirePermission('stock.receipt'),
  validate({ body: cancelSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    const existing = await getDoc(req, GoodsReceipt, req.params.id);
    let tx: StockTx | undefined;
    const doc = await withTx(async (session) => {
      const r = await claim<any>(GoodsReceipt, req, req.params.id, ['draft', 'posted'], { status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason }, session);
      if (existing.status === 'posted') {
        tx = await StockTx.forShop(sid, session, a.userId);
        for (const l of r.lines) {
          await tx.move({ branchId: r.branchId, productId: l.productId, type: 'goods_receipt_reversal', quantity: -l.qty, unitCost: l.cost, docType: 'goods_receipt', docId: r._id, docNumber: r.number, note: req.body.reason });
        }
        await Supplier.updateOne({ _id: r.supplierId, shopId: sid }, { $inc: { balance: -r.total } }, { session });
      }
      await audit(req, { action: 'goods_receipt.cancelled', entity: 'goods_receipt', entityId: r._id, meta: { reason: req.body.reason, wasPosted: existing.status === 'posted' } }, session);
      return r;
    });
    if (tx) flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

/* ===================================================================== supplier returns */

export const supplierReturnsRouter = Router();
supplierReturnsRouter.use(authenticate);

async function postSupplierReturn(req: Request, id: string) {
  const a = auth(req);
  const sid = shopId(req);
  let tx!: StockTx;
  const doc = await withTx(async (session) => {
    const r = await claim<any>(SupplierReturn, req, id, ['draft'], { status: 'posted', postedAt: new Date() }, session);
    assertBranchAccess(req, r.branchId);
    if (r.goodsReceiptId) {
      // never return more than was received, counting earlier posted returns of the same receipt
      const receipt = await GoodsReceipt.findOne({ _id: r.goodsReceiptId, shopId: sid }).session(session).lean();
      if (!receipt || receipt.status !== 'posted') throw unprocessable('DOCUMENT_NOT_POSTED');
      const earlier = await SupplierReturn.find({ shopId: sid, goodsReceiptId: r.goodsReceiptId, status: 'posted', _id: { $ne: r._id } }).session(session).lean();
      const returned = new Map<string, number>();
      for (const e of earlier) for (const l of e.lines) returned.set(String(l.productId), (returned.get(String(l.productId)) ?? 0) + l.qty);
      const received = new Map<string, number>();
      for (const l of receipt.lines) received.set(String(l.productId), (received.get(String(l.productId)) ?? 0) + l.qty);
      const now = new Map<string, number>();
      for (const l of r.lines) now.set(String(l.productId), (now.get(String(l.productId)) ?? 0) + l.qty);
      for (const [pid, qty] of now) {
        if (qty + (returned.get(pid) ?? 0) > (received.get(pid) ?? 0) + 1e-9) throw unprocessable('RETURN_EXCEEDS_RECEIVED', undefined, { productId: pid });
      }
    }
    tx = await StockTx.forShop(sid, session, a.userId);
    for (const l of r.lines) {
      await tx.move({ branchId: r.branchId, productId: l.productId, type: 'supplier_return', quantity: -l.qty, unitCost: l.cost, docType: 'supplier_return', docId: r._id, docNumber: r.number });
    }
    await Supplier.updateOne({ _id: r.supplierId, shopId: sid }, { $inc: { balance: -r.total } }, { session });
    await lockCurrency(sid, session);
    await audit(req, { action: 'supplier_return.posted', entity: 'supplier_return', entityId: r._id, meta: { number: r.number, total: r.total } }, session);
    return r;
  });
  flush(tx.events);
  return doc;
}

supplierReturnsRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: documentListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, SupplierReturn).paginate(listFilter(req, q), { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => d.toJSON()), meta);
  }),
);

supplierReturnsRouter.post(
  '/',
  requirePermission('stock.receipt'),
  validate({ body: supplierReturnInputSchema }),
  h(async (req, res) => {
    const { post, ...b } = req.body as z.infer<typeof supplierReturnInputSchema>;
    await assertBranch(req, b.branchId);
    await assertSupplier(req, b.supplierId);
    await assertProducts(req, b.lines.map((l) => l.productId));
    if (b.goodsReceiptId) {
      const receipt = await repo(req, GoodsReceipt).findById(b.goodsReceiptId);
      if (!receipt) throw notFound();
      if (String(receipt.supplierId) !== b.supplierId) throw badRequest('BAD_REQUEST');
    }
    const number = await nextNumber(shopId(req), 'supplierReturn', 'SR');
    const doc = await repo(req, SupplierReturn).create({ ...b, number, total: sum(b.lines), createdBy: auth(req).userId, status: 'draft' });
    const final = post ? await postSupplierReturn(req, String(doc._id)) : doc;
    created(res, (await withNames(req, [final]))[0]);
  }),
);

supplierReturnsRouter.get('/:id', idParams, requirePermission(...VIEW), h(async (req, res) => ok(res, (await withNames(req, [await getDoc(req, SupplierReturn, req.params.id)]))[0])));

supplierReturnsRouter.post(
  '/:id/post',
  idParams,
  requirePermission('stock.receipt'),
  h(async (req, res) => {
    await getDoc(req, SupplierReturn, req.params.id);
    ok(res, (await withNames(req, [await postSupplierReturn(req, req.params.id)]))[0]);
  }),
);

supplierReturnsRouter.post(
  '/:id/cancel',
  idParams,
  requirePermission('stock.receipt'),
  validate({ body: cancelSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    const existing = await getDoc(req, SupplierReturn, req.params.id);
    let tx: StockTx | undefined;
    const doc = await withTx(async (session) => {
      const r = await claim<any>(SupplierReturn, req, req.params.id, ['draft', 'posted'], { status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason }, session);
      if (existing.status === 'posted') {
        tx = await StockTx.forShop(sid, session, a.userId);
        for (const l of r.lines) {
          await tx.move({ branchId: r.branchId, productId: l.productId, type: 'supplier_return_reversal', quantity: l.qty, unitCost: l.cost, docType: 'supplier_return', docId: r._id, docNumber: r.number, note: req.body.reason });
        }
        await Supplier.updateOne({ _id: r.supplierId, shopId: sid }, { $inc: { balance: r.total } }, { session });
      }
      await audit(req, { action: 'supplier_return.cancelled', entity: 'supplier_return', entityId: r._id, meta: { reason: req.body.reason } }, session);
      return r;
    });
    if (tx) flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

/* ============================================================================== transfers */

export const transfersRouter = Router();
transfersRouter.use(authenticate);

transfersRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: documentListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, Transfer).paginate(listFilter(req, q, ['fromBranchId', 'toBranchId']), { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => d.toJSON()), meta);
  }),
);

transfersRouter.post(
  '/',
  requirePermission('stock.transfer'),
  validate({ body: transferInputSchema }),
  h(async (req, res) => {
    const b = req.body as z.infer<typeof transferInputSchema>;
    if (b.fromBranchId === b.toBranchId) throw unprocessable('SAME_BRANCH');
    if (!(await repo(req, Branch).exists({ _id: b.fromBranchId })) || !(await repo(req, Branch).exists({ _id: b.toBranchId }))) throw notFound('BRANCH_NOT_FOUND');
    assertBranchAccess(req, b.fromBranchId); // the sender creates the transfer
    await assertProducts(req, b.lines.map((l) => l.productId));
    const number = await nextNumber(shopId(req), 'transfer', 'TR');
    const doc = await repo(req, Transfer).create({
      number, fromBranchId: b.fromBranchId, toBranchId: b.toBranchId, note: b.note, status: 'draft', createdBy: auth(req).userId,
      lines: b.lines.map((l) => ({ productId: l.productId, qtySent: l.qty })),
    });
    created(res, (await withNames(req, [doc]))[0]);
  }),
);


transfersRouter.get('/:id', idParams, requirePermission(...VIEW), h(async (req, res) => ok(res, (await withNames(req, [await getDoc(req, Transfer, req.params.id, ['fromBranchId', 'toBranchId'])]))[0])));

/** Sending takes the stock out of the source branch at its average cost. */
transfersRouter.post(
  '/:id/send',
  idParams,
  requirePermission('stock.transfer'),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    await getDoc(req, Transfer, req.params.id, ['fromBranchId', 'toBranchId']);
    let tx!: StockTx;
    const doc = await withTx(async (session) => {
      const t = await claim<any>(Transfer, req, req.params.id, ['draft'], { status: 'sent', sentAt: new Date() }, session);
      assertBranchAccess(req, t.fromBranchId);
      tx = await StockTx.forShop(sid, session, a.userId);
      for (const l of t.lines) {
        const r = await tx.move({ branchId: t.fromBranchId, productId: l.productId, type: 'transfer_out', quantity: -l.qtySent, docType: 'transfer', docId: t._id, docNumber: t.number });
        l.unitCost = r.avgCost;
      }
      await t.save({ session });
      await lockCurrency(sid, session);
      await audit(req, { action: 'transfer.sent', entity: 'transfer', entityId: t._id, meta: { number: t.number } }, session);
      return t;
    });
    flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

/** Receiving adds stock to the destination with a quantity check; differences are flagged. */
transfersRouter.post(
  '/:id/receive',
  idParams,
  requirePermission('stock.transfer'),
  validate({ body: transferReceiveSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    await getDoc(req, Transfer, req.params.id, ['fromBranchId', 'toBranchId']);
    const b = req.body as z.infer<typeof transferReceiveSchema>;
    let tx!: StockTx;
    const doc = await withTx(async (session) => {
      const t = await claim<any>(Transfer, req, req.params.id, ['sent'], { status: 'received', receivedAt: new Date(), receivedBy: a.userId, receiveNote: b.note }, session);
      if (!canAccessBranch(a, t.toBranchId)) throw forbidden();
      const received = new Map((b.lines ?? []).map((l) => [l.productId, l.qtyReceived]));
      for (const pid of received.keys()) if (!t.lines.some((l: any) => String(l.productId) === pid)) throw notFound('PRODUCT_NOT_FOUND');
      tx = await StockTx.forShop(sid, session, a.userId);
      let discrepancy = false;
      for (const l of t.lines) {
        const qty = received.has(String(l.productId)) ? received.get(String(l.productId))! : l.qtySent;
        l.qtyReceived = qty;
        if (Math.abs(qty - l.qtySent) > 1e-9) discrepancy = true;
        if (qty > 0) await tx.move({ branchId: t.toBranchId, productId: l.productId, type: 'transfer_in', quantity: qty, unitCost: l.unitCost, docType: 'transfer', docId: t._id, docNumber: t.number });
      }
      t.discrepancy = discrepancy;
      await t.save({ session });
      await audit(req, { action: 'transfer.received', entity: 'transfer', entityId: t._id, meta: { number: t.number, discrepancy, note: b.note } }, session);
      return t;
    });
    flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

transfersRouter.post(
  '/:id/cancel',
  idParams,
  requirePermission('stock.transfer'),
  validate({ body: cancelSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    const existing = await getDoc(req, Transfer, req.params.id, ['fromBranchId', 'toBranchId']);
    if (existing.status === 'received') throw unprocessable('DOCUMENT_POSTED');
    let tx: StockTx | undefined;
    const doc = await withTx(async (session) => {
      const t = await claim<any>(Transfer, req, req.params.id, ['draft', 'sent'], { status: 'cancelled', cancelReason: req.body.reason }, session);
      if (existing.status === 'sent') {
        tx = await StockTx.forShop(sid, session, a.userId);
        for (const l of t.lines) await tx.move({ branchId: t.fromBranchId, productId: l.productId, type: 'transfer_cancel', quantity: l.qtySent, unitCost: l.unitCost, docType: 'transfer', docId: t._id, docNumber: t.number, note: req.body.reason });
      }
      await audit(req, { action: 'transfer.cancelled', entity: 'transfer', entityId: t._id, meta: { reason: req.body.reason } }, session);
      return t;
    });
    if (tx) flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

/* ============================================================================= write-offs */

export const writeOffsRouter = Router();
writeOffsRouter.use(authenticate);

async function postWriteOff(req: Request, id: string) {
  const a = auth(req);
  const sid = shopId(req);
  let tx!: StockTx;
  const doc = await withTx(async (session) => {
    const w = await claim<any>(WriteOff, req, id, ['draft'], { status: 'posted', postedAt: new Date() }, session);
    assertBranchAccess(req, w.branchId);
    tx = await StockTx.forShop(sid, session, a.userId);
    for (const l of w.lines) {
      const r = await tx.move({ branchId: w.branchId, productId: l.productId, type: 'write_off', quantity: -l.qty, docType: 'write_off', docId: w._id, docNumber: w.number, note: w.reason });
      l.cost = r.avgCost; // the loss is valued at the average cost at that moment
    }
    w.total = sum(w.lines);
    await w.save({ session });
    await lockCurrency(sid, session);
    await audit(req, { action: 'write_off.posted', entity: 'write_off', entityId: w._id, meta: { number: w.number, reason: w.reason, total: w.total } }, session);
    return w;
  });
  flush(tx.events);
  return doc;
}

writeOffsRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: documentListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, WriteOff).paginate(listFilter(req, q), { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => d.toJSON()), meta);
  }),
);

writeOffsRouter.post(
  '/',
  requirePermission('stock.writeoff'),
  validate({ body: writeOffInputSchema }),
  h(async (req, res) => {
    const { post, ...b } = req.body as z.infer<typeof writeOffInputSchema>;
    await assertBranch(req, b.branchId);
    await assertProducts(req, b.lines.map((l) => l.productId));
    const number = await nextNumber(shopId(req), 'writeOff', 'WO');
    const doc = await repo(req, WriteOff).create({ ...b, number, createdBy: auth(req).userId, status: 'draft' });
    const final = post ? await postWriteOff(req, String(doc._id)) : doc;
    created(res, (await withNames(req, [final]))[0]);
  }),
);

writeOffsRouter.get('/:id', idParams, requirePermission(...VIEW), h(async (req, res) => ok(res, (await withNames(req, [await getDoc(req, WriteOff, req.params.id)]))[0])));

writeOffsRouter.post(
  '/:id/post',
  idParams,
  requirePermission('stock.writeoff'),
  h(async (req, res) => {
    await getDoc(req, WriteOff, req.params.id);
    ok(res, (await withNames(req, [await postWriteOff(req, req.params.id)]))[0]);
  }),
);

writeOffsRouter.post(
  '/:id/cancel',
  idParams,
  requirePermission('stock.writeoff'),
  validate({ body: cancelSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    const existing = await getDoc(req, WriteOff, req.params.id);
    let tx: StockTx | undefined;
    const doc = await withTx(async (session) => {
      const w = await claim<any>(WriteOff, req, req.params.id, ['draft', 'posted'], { status: 'cancelled', cancelledAt: new Date(), cancelReason: req.body.reason }, session);
      if (existing.status === 'posted') {
        tx = await StockTx.forShop(sid, session, a.userId);
        for (const l of w.lines) await tx.move({ branchId: w.branchId, productId: l.productId, type: 'write_off_reversal', quantity: l.qty, unitCost: l.cost, docType: 'write_off', docId: w._id, docNumber: w.number, note: req.body.reason });
      }
      await audit(req, { action: 'write_off.cancelled', entity: 'write_off', entityId: w._id, meta: { reason: req.body.reason } }, session);
      return w;
    });
    if (tx) flush(tx.events);
    ok(res, (await withNames(req, [doc]))[0]);
  }),
);

/* ========================================================================== stock counts */

export const stockCountsRouter = Router();
stockCountsRouter.use(authenticate);

stockCountsRouter.get(
  '/',
  requirePermission(...VIEW),
  validate({ query: documentListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as any;
    const { items, meta } = await repo(req, StockCount).paginate(listFilter(req, q), { page: q.page, limit: q.limit, sort: '-createdAt' });
    ok(res, items.map((d) => ({ ...d.toJSON(), lines: undefined, lineCount: d.lines.length })), meta);
  }),
);

stockCountsRouter.post(
  '/',
  requirePermission('stock.count'),
  validate({ body: stockCountInputSchema }),
  h(async (req, res) => {
    const b = req.body as z.infer<typeof stockCountInputSchema>;
    await assertBranch(req, b.branchId);
    let lines: Array<{ productId: Types.ObjectId; counted: null }> = [];
    if (b.prefill) {
      const filter: Record<string, any> = { isActive: true, deletedAt: null };
      if (b.categoryId) {
        if (!(await repo(req, Category).exists({ _id: b.categoryId }))) throw notFound();
        filter.categoryId = { $in: await categoryWithDescendants(req, b.categoryId) };
      }
      const products = await repo(req, Product).find(filter, { sort: 'name' }).select('_id').limit(20000).lean();
      lines = products.map((p) => ({ productId: p._id as Types.ObjectId, counted: null }));
    }
    const number = await nextNumber(shopId(req), 'stockCount', 'SC');
    const doc = await repo(req, StockCount).create({ number, branchId: b.branchId, categoryId: b.categoryId, note: b.note, lines, status: 'draft', createdBy: auth(req).userId });
    created(res, doc.toJSON());
  }),
);

/** Live view with the current expected quantity next to what has been counted so far. */
stockCountsRouter.get(
  '/:id',
  idParams,
  requirePermission(...VIEW),
  h(async (req, res) => {
    const doc = await getDoc(req, StockCount, req.params.id);
    const ids = doc.lines.map((l: any) => l.productId);
    const [products, stocks] = await Promise.all([
      repo(req, Product).find({ _id: { $in: ids } }).select('name barcodes unit').lean(),
      repo(req, Stock).find({ branchId: doc.branchId, productId: { $in: ids } }).select('productId quantity').lean(),
    ]);
    const pm = new Map(products.map((p) => [String(p._id), p]));
    const sm = new Map(stocks.map((s) => [String(s.productId), s.quantity as number]));
    const j = doc.toJSON();
    j.lines = j.lines.map((l: any) => {
      const expected = doc.status === 'posted' ? l.expected : (sm.get(String(l.productId)) ?? 0);
      return { ...l, expected, diff: l.counted === null ? null : Math.round((l.counted - expected) * 1000) / 1000, productName: pm.get(String(l.productId))?.name, barcode: pm.get(String(l.productId))?.barcodes?.[0], unit: pm.get(String(l.productId))?.unit };
    });
    ok(res, j);
  }),
);

/** Scan/enter counted quantities. Products not yet in the sheet are added. */
stockCountsRouter.put(
  '/:id/lines',
  idParams,
  requirePermission('stock.count'),
  validate({ body: stockCountLinesSchema }),
  h(async (req, res) => {
    const doc = await getDoc(req, StockCount, req.params.id);
    if (doc.status !== 'draft') throw unprocessable('DOCUMENT_EDIT_FORBIDDEN');
    await assertProducts(req, req.body.lines.map((l: any) => l.productId));
    const byId = new Map<string, any>(doc.lines.map((l: any) => [String(l.productId), l]));
    for (const l of req.body.lines) {
      const existing = byId.get(l.productId);
      if (existing) existing.counted = l.counted;
      else doc.lines.push({ productId: oid(l.productId), counted: l.counted, expected: null, diff: null });
    }
    await doc.save();
    ok(res, { lineCount: doc.lines.length });
  }),
);

/** Posting adjusts stock to the counted quantity (counted - stock at that moment). */
stockCountsRouter.post(
  '/:id/post',
  idParams,
  requirePermission('stock.count'),
  validate({ body: stockCountPostSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const sid = shopId(req);
    await getDoc(req, StockCount, req.params.id);
    let tx!: StockTx;
    const doc = await withTx(async (session) => {
      const c = await claim<any>(StockCount, req, req.params.id, ['draft'], { status: 'posted', postedAt: new Date() }, session);
      assertBranchAccess(req, c.branchId);
      tx = await StockTx.forShop(sid, session, a.userId);
      const stocks = await Stock.find({ shopId: sid, branchId: c.branchId, productId: { $in: c.lines.map((l: any) => l.productId) } }).session(session).lean();
      const sm = new Map(stocks.map((s) => [String(s.productId), s.quantity as number]));
      for (const l of c.lines) {
        const counted = l.counted ?? (req.body.zeroUncounted ? 0 : null);
        if (counted === null) continue;
        const expected = sm.get(String(l.productId)) ?? 0;
        const diff = Math.round((counted - expected) * 1000) / 1000;
        l.counted = counted;
        l.expected = expected;
        l.diff = diff;
        if (diff !== 0) await tx.move({ branchId: c.branchId, productId: l.productId, type: 'count_adjustment', quantity: diff, docType: 'stock_count', docId: c._id, docNumber: c.number });
      }
      await c.save({ session });
      await lockCurrency(sid, session);
      await audit(req, { action: 'stock_count.posted', entity: 'stock_count', entityId: c._id, meta: { number: c.number, adjusted: c.lines.filter((l: any) => l.diff).length } }, session);
      return c;
    });
    flush(tx.events);
    ok(res, doc.toJSON());
  }),
);

stockCountsRouter.post(
  '/:id/cancel',
  idParams,
  requirePermission('stock.count'),
  validate({ body: cancelSchema }),
  h(async (req, res) => {
    await getDoc(req, StockCount, req.params.id);
    const doc = await withTx((session) => claim<any>(StockCount, req, req.params.id, ['draft'], { status: 'cancelled' }, session));
    await audit(req, { action: 'stock_count.cancelled', entity: 'stock_count', entityId: doc._id, meta: { reason: req.body.reason } });
    ok(res, doc.toJSON());
  }),
);
