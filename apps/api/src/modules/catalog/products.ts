import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  buildInternalBarcode,
  importMappingSchema,
  isValidEan13,
  labelsSchema,
  objectId,
  productInputSchema,
  productListQuerySchema,
  productUpdateSchema,
  translate,
  type Language,
} from '@kass/shared';
import { audit } from '../../lib/audit';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo, shopId } from '../../lib/http';
import { nextSeq } from '../../lib/counters';
import { handleUpload, imageUpload, spreadsheetUpload, storeImage } from '../../lib/storage';
import { escapeRegex, oid, parseSort } from '../../lib/util';
import { authenticate, can, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Category, Price, PriceChange, Product, type ProductDoc } from '../../models/catalog';
import { Branch, Shop } from '../../models/core';
import { Sale } from '../../models/sales';
import { GoodsReceipt, Stock, StockCount, StockMovement, SupplierReturn, Transfer, WriteOff } from '../../models/stock';
import { stockStatusFilter } from '../stock/stock';
import { categoryWithDescendants } from './categories';
import { applyPrices } from './priceService';
import { runImport } from './importer';
import { renderCodesPdf, renderLabelsPdf } from './labels';
import { buildWorkbookBuffer, parseSpreadsheet, suggestMapping } from './spreadsheet';

export const productsRouter = Router();
productsRouter.use(authenticate);

const idParams = validate({ params: z.object({ id: objectId }) });

/* ------------------------------------------------------------------ helpers */

async function assertNoDuplicates(req: Request, input: { barcodes?: string[]; sku?: string }, exceptId?: string) {
  const r = repo(req, Product);
  if (input.barcodes?.length) {
    const clash = await r.findOne({ barcodes: { $in: input.barcodes }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('name barcodes').lean();
    if (clash) {
      const barcode = input.barcodes.find((b) => clash.barcodes.includes(b));
      throw conflict('DUPLICATE_BARCODE', { barcode, productId: String(clash._id), productName: clash.name });
    }
  }
  if (input.sku) {
    const clash = await r.findOne({ sku: input.sku, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('name').lean();
    if (clash) throw conflict('DUPLICATE_SKU', { sku: input.sku, productId: String(clash._id), productName: clash.name });
  }
}

async function assertCategory(req: Request, categoryId?: string | null) {
  if (categoryId && !(await repo(req, Category).exists({ _id: categoryId }))) throw notFound();
}

/** The cost price is shown to the shop admin and to staff who see reports, never to cashiers. */
const seesCost = (req: Request) => { const a = auth(req); return a.role === 'shop_admin' || can(a, 'reports.view'); };

function present(req: Request, p: ProductDoc | any, extra: Record<string, unknown> = {}) {
  const j = typeof p.toJSON === 'function' ? p.toJSON() : { ...p, id: String(p._id), _id: undefined };
  if (!seesCost(req)) delete j.costPrice;
  return { ...j, ...extra };
}

/** Cashiers see the catalog but never cost data; prices are returned only for the requested branch. */
async function priceFor(req: Request, productIds: unknown[], branchId?: string) {
  if (!branchId) return new Map<string, number>();
  const a = auth(req);
  if (a.role !== 'shop_admin' && !a.branchIds.some((b) => String(b) === branchId)) throw forbidden();
  const prices = await repo(req, Price).find({ branchId, productId: { $in: productIds } }).select('productId price').lean();
  return new Map(prices.map((p) => [String(p.productId), p.price as number]));
}

/* --------------------------------------------------------------------- list */

productsRouter.get(
  '/',
  requirePermission('products.view'),
  validate({ query: productListQuerySchema }),
  h(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof productListQuerySchema>;
    const filter: Record<string, any> = { deletedAt: null };
    if (q.q) {
      const esc = escapeRegex(q.q);
      filter.$or = [{ name: new RegExp(esc, 'i') }, { sku: new RegExp(esc, 'i') }, { barcodes: new RegExp('^' + esc) }];
    }
    if (q.barcode) filter.barcodes = q.barcode;
    if (q.categoryId) filter.categoryId = { $in: await categoryWithDescendants(req, q.categoryId) };
    if (q.active) filter.isActive = q.active === 'true';
    if (q.missingMxik) filter.$and = [...(filter.$and ?? []), { $or: [{ mxikCode: null }, { packageCode: null }] }];
    if (q.missingPriceBranchId) {
      const priced = await repo(req, Price).find({ branchId: q.missingPriceBranchId }).select('productId').lean();
      filter._id = { $nin: priced.map((p) => p.productId) };
    }
    if (q.stockStatus && q.branchId) {
      // 'out' also covers products that never had stock in the branch
      const stockFilter =
        q.stockStatus === 'in' ? stockStatusFilter('positive') : q.stockStatus === 'out' ? { quantity: { $gt: 0 } } : stockStatusFilter(q.stockStatus);
      const rows = await repo(req, Stock).find({ branchId: q.branchId, ...stockFilter }).select('productId').lean();
      const ids = rows.map((r) => r.productId);
      filter._id = q.stockStatus === 'out' ? { $nin: ids } : { $in: ids, ...(filter._id ?? {}) };
    }
    const { items, meta } = await repo(req, Product).paginate(filter, {
      page: q.page,
      limit: q.limit,
      sort: parseSort(q.sort, ['name', 'createdAt', 'sku'], 'name'),
    });
    const prices = await priceFor(req, items.map((i) => i._id), q.branchId);
    ok(res, items.map((p) => present(req, p, q.branchId ? { price: prices.get(String(p._id)) ?? null } : {})), meta);
  }),
);

/** Barcode lookup for scanners and the POS (also used to create a product from an unknown code). */
productsRouter.get(
  '/by-barcode/:code',
  requirePermission('products.view', 'sales.create'),
  validate({ params: z.object({ code: z.string().min(1).max(128) }), query: z.object({ branchId: objectId.optional() }) }),
  h(async (req, res) => {
    const p = await repo(req, Product).findOne({ barcodes: req.params.code });
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const prices = await priceFor(req, [p._id], (req.query as any).branchId);
    ok(res, present(req, p, (req.query as any).branchId ? { price: prices.get(String(p._id)) ?? null } : {}));
  }),
);

/* ------------------------------------------------------------ import / export */

/** Step 1: read the file and propose a column mapping. Nothing is saved. */
productsRouter.post(
  '/import/preview',
  requirePermission('products.manage'),
  handleUpload(spreadsheetUpload),
  h(async (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw badRequest('IMPORT_FILE_INVALID');
    const sheet = await parseSpreadsheet(file.buffer, file.originalname);
    ok(res, { columns: sheet.columns, sample: sheet.rows.slice(0, 10), totalRows: sheet.rows.length, suggestedMapping: suggestMapping(sheet.columns) });
  }),
);

/** Step 2: import with the confirmed mapping. Returns created/updated counts and an error report. */
productsRouter.post(
  '/import',
  requirePermission('products.manage'),
  handleUpload(spreadsheetUpload),
  h(async (req, res) => {
    const a = auth(req);
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw badRequest('IMPORT_FILE_INVALID');
    let body: { mapping: z.infer<typeof importMappingSchema>; updateExisting: boolean; priceBranchIds: string[] };
    try {
      body = z
        .object({
          mapping: importMappingSchema,
          updateExisting: z.boolean().default(true),
          priceBranchIds: z.array(objectId).default([]),
        })
        .parse(JSON.parse(req.body.options ?? '{}'));
    } catch {
      throw badRequest('VALIDATION_ERROR');
    }
    if (!body.mapping.name) throw badRequest('VALIDATION_ERROR', [{ path: 'mapping.name', message: 'required' }]);
    // Import can set prices, and prices are the shop admin's right alone.
    if (body.priceBranchIds.length && a.role !== 'shop_admin') throw forbidden('PRICE_ADMIN_ONLY');
    if (body.priceBranchIds.length && (await repo(req, Branch).count({ _id: { $in: body.priceBranchIds } })) !== new Set(body.priceBranchIds).size) {
      throw notFound('BRANCH_NOT_FOUND');
    }
    const sheet = await parseSpreadsheet(file.buffer, file.originalname);
    const result = await runImport(req, sheet, body, a.userId);
    await audit(req, { action: 'products.imported', entity: 'product', meta: { file: file.originalname, ...result, errors: result.errors.length } });
    ok(res, result);
  }),
);

productsRouter.get(
  '/export',
  requirePermission('products.view'),
  h(async (req, res) => {
    const a = auth(req);
    const includePrices = a.role === 'shop_admin' || can(a, 'prices.view');
    const [products, cats, branches] = await Promise.all([
      repo(req, Product).find({ deletedAt: null }, { sort: 'name' }).lean(),
      repo(req, Category).find({}).lean(),
      repo(req, Branch).find(a.role === 'shop_admin' ? {} : { _id: { $in: a.branchIds } }, { sort: 'name' }),
    ]);
    const catName = new Map(cats.map((c) => [String(c._id), c]));
    const pathOf = (id?: unknown) => {
      const c = id ? catName.get(String(id)) : undefined;
      if (!c) return '';
      return [...(c.path as any[]).map((p) => catName.get(String(p))?.name ?? ''), c.name].filter(Boolean).join(' > ');
    };
    const priceMap = new Map<string, number>();
    if (includePrices) {
      const prices = await repo(req, Price).find({ branchId: { $in: branches.map((b) => b._id) } }).select('productId branchId price').lean();
      prices.forEach((p) => priceMap.set(`${p.productId}:${p.branchId}`, p.price as number));
    }
    const header = ['Name', 'SKU', 'Barcodes', 'Category', 'Unit', 'VAT %', 'MXIK', 'Package code', 'Marked', 'Weighted', 'Active', ...(includePrices ? branches.map((b) => `Price: ${b.name}`) : [])];
    const rows = products.map((p) => [
      p.name, p.sku ?? '', (p.barcodes ?? []).join(', '), pathOf(p.categoryId), p.unit, p.vatRate ?? '', p.mxikCode ?? '', p.packageCode ?? '',
      p.isMarked ? 'yes' : '', p.isWeighted ? 'yes' : '', p.isActive ? 'yes' : 'no',
      ...(includePrices ? branches.map((b) => { const v = priceMap.get(`${p._id}:${b._id}`); return v === undefined ? '' : v / 100; }) : []),
    ]);
    const buf = await buildWorkbookBuffer('Products', header, rows as any);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="products.xlsx"');
    res.send(buf);
  }),
);

/**
 * Every product's QR code or barcode on printable A4 sheets. Products without a barcode first get
 * an internal one (when the user may manage products), so every product ends up with a code.
 */
productsRouter.get(
  '/codes',
  requirePermission('products.view'),
  validate({ query: z.object({ type: z.enum(['qr', 'barcode']).default('qr'), active: z.enum(['true', 'all']).default('true'), format: z.enum(['pdf', 'json']).default('pdf') }) }),
  h(async (req, res) => {
    const a = auth(req);
    const q = req.query as unknown as { type: 'qr' | 'barcode'; active: 'true' | 'all'; format: 'pdf' | 'json' };
    const products = await repo(req, Product).find(q.active === 'true' ? { isActive: true, deletedAt: null } : { deletedAt: null }, { sort: 'name' });
    let generated = 0;
    if (can(a, 'products.manage')) {
      for (const p of products) {
        if (p.barcodes?.length) continue;
        p.barcodes.push(await nextInternalBarcode(req));
        await p.save();
        generated++;
      }
      if (generated) await audit(req, { action: 'product.barcodes_generated', entity: 'product', meta: { count: generated, via: 'codes_export' } });
    }
    const items = products.filter((p) => p.barcodes?.length).map((p) => ({ id: String(p._id), name: p.name, code: p.barcodes[0] }));
    // JSON: the list the web app turns into one PNG per product (for the ZIP download)
    if (q.format === 'json') return ok(res, { items, generated });
    const lang = (a.user.language as Language) ?? 'uz';
    const doc = renderCodesPdf(items, q.type, translate(lang, q.type === 'qr' ? 'shop.products.exportQr' : 'shop.products.exportBarcodes'));
    const file = q.type === 'qr' ? 'qr-codes.pdf' : 'barcodes.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('X-Codes-Count', String(items.length));
    res.setHeader('X-Codes-Generated', String(generated));
    doc.pipe(res);
    doc.end();
  }),
);

/* -------------------------------------------------------------------- labels */

productsRouter.post(
  '/labels',
  requirePermission('products.view'),
  validate({ body: labelsSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof labelsSchema>;
    if (a.role !== 'shop_admin' && !a.branchIds.some((x) => String(x) === b.branchId)) throw forbidden();
    const [shop, products, prices] = await Promise.all([
      Shop.findById(a.shopId),
      repo(req, Product).find({ _id: { $in: b.items.map((i) => i.productId) } }).lean(),
      repo(req, Price).find({ branchId: b.branchId, productId: { $in: b.items.map((i) => i.productId) } }).lean(),
    ]);
    const pMap = new Map(products.map((p) => [String(p._id), p]));
    const priceMap = new Map(prices.map((p) => [String(p.productId), p.price as number]));
    const items = b.items
      .filter((i) => pMap.has(i.productId))
      .map((i) => ({
        name: pMap.get(i.productId)!.name,
        price: priceMap.get(i.productId) ?? null,
        barcode: pMap.get(i.productId)!.barcodes?.[0] ?? null,
        copies: i.copies,
      }));
    const doc = renderLabelsPdf(items, shop!.currency, (a.user.language as Language) ?? 'uz');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="labels.pdf"');
    doc.pipe(res);
    doc.end();
  }),
);

/* ------------------------------------------------------------------- CRUD */

productsRouter.post(
  '/',
  requirePermission('products.manage'),
  validate({ body: productInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const { prices, ...input } = req.body as z.infer<typeof productInputSchema>;
    // Prices are the shop admin's right alone: no permission can delegate it.
    if ((prices?.length || (input.costPrice !== undefined && input.costPrice !== null)) && a.role !== 'shop_admin') throw forbidden('PRICE_ADMIN_ONLY');
    input.barcodes = [...new Set(input.barcodes)];
    await assertNoDuplicates(req, input);
    await assertCategory(req, input.categoryId);
    const p = await repo(req, Product).create({ ...input, categoryId: input.categoryId ? oid(input.categoryId) : null });
    if (prices?.length) {
      await applyPrices({ shopId: shopId(req), userId: a.userId, changes: prices.map((x) => ({ productId: p._id, branchId: x.branchId, price: x.price })), source: 'manual' });
    }
    await audit(req, { action: 'product.created', entity: 'product', entityId: p._id, after: p });
    created(res, present(req, p));
  }),
);

productsRouter.get(
  '/:id',
  idParams,
  requirePermission('products.view'),
  h(async (req, res) => {
    const a = auth(req);
    const p = await repo(req, Product).findById(req.params.id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const priceFilter: Record<string, unknown> = { productId: p._id };
    if (a.role !== 'shop_admin') priceFilter.branchId = { $in: a.branchIds };
    const prices = await repo(req, Price).find(priceFilter).select('branchId price').lean();
    ok(res, present(req, p, { prices: prices.map((x) => ({ branchId: String(x.branchId), price: x.price })) }));
  }),
);

productsRouter.patch(
  '/:id',
  idParams,
  requirePermission('products.manage'),
  validate({ body: productUpdateSchema }),
  h(async (req, res) => {
    const p = await repo(req, Product).findById(req.params.id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const before = p.toObject();
    const b = req.body as z.infer<typeof productUpdateSchema>;
    if (b.costPrice !== undefined && b.costPrice !== p.costPrice && auth(req).role !== 'shop_admin') throw forbidden('PRICE_ADMIN_ONLY');
    if (b.barcodes) b.barcodes = [...new Set(b.barcodes)];
    await assertNoDuplicates(req, { barcodes: b.barcodes, sku: b.sku }, String(p._id));
    if (b.categoryId !== undefined) await assertCategory(req, b.categoryId);
    const { categoryId, ...rest } = b;
    Object.assign(p, rest);
    if (categoryId !== undefined) p.categoryId = (categoryId ? oid(categoryId) : null) as any;
    if (b.sku === undefined && 'sku' in req.body) p.sku = undefined;
    await p.save();
    await audit(req, { action: 'product.updated', entity: 'product', entityId: p._id, before, after: p });
    ok(res, present(req, p));
  }),
);

productsRouter.post(
  '/:id/image',
  idParams,
  requirePermission('products.manage'),
  handleUpload(imageUpload),
  h(async (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw badRequest('FILE_TYPE_INVALID');
    const p = await repo(req, Product).findById(req.params.id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const stored = await storeImage(`products/${auth(req).shopId}`, file.buffer);
    p.imageUrl = stored.url;
    await p.save();
    ok(res, present(req, p));
  }),
);

/** Internal EAN-13 for products without a factory barcode: 2 + shop code + sequence + check digit. */
productsRouter.post(
  '/reserve-barcode',
  requirePermission('products.manage'),
  h(async (req, res) => {
    // A new product form is pre-filled with this code, so every product gets a barcode (and QR) at once.
    ok(res, { code: await nextInternalBarcode(req) });
  }),
);

/** Next free internal EAN-13 of the shop: 2 + shop code + sequence + check digit. */
async function nextInternalBarcode(req: Request): Promise<string> {
  const shop = await Shop.findById(auth(req).shopId);
  if (shop?.shopCode === undefined || shop.shopCode === null) throw unprocessable('BAD_REQUEST');
  for (let i = 0; i < 10; i++) {
    const code = buildInternalBarcode(shop.shopCode, await nextSeq(shopId(req), 'internalBarcode'));
    if (isValidEan13(code) && !(await repo(req, Product).exists({ barcodes: code }))) return code;
  }
  throw unprocessable('BAD_REQUEST');
}

/**
 * Delete a product. A product that was never sold or moved is removed with its prices; one with
 * history is taken out of the catalog instead (hidden everywhere, barcodes freed for reuse) so past
 * receipts and reports stay correct.
 */
productsRouter.delete(
  '/:id',
  idParams,
  requirePermission('products.manage'),
  h(async (req, res) => {
    const p = await repo(req, Product).findOne({ _id: req.params.id, deletedAt: null });
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const id = p._id;
    const used = await Promise.all([
      repo(req, Sale).exists({ 'lines.productId': id }),
      repo(req, StockMovement).exists({ productId: id }),
      repo(req, GoodsReceipt).exists({ 'lines.productId': id }),
      repo(req, SupplierReturn).exists({ 'lines.productId': id }),
      repo(req, Transfer).exists({ 'lines.productId': id }),
      repo(req, WriteOff).exists({ 'lines.productId': id }),
      repo(req, StockCount).exists({ 'lines.productId': id }),
    ]);
    const before = p.toObject();
    if (used.some(Boolean)) {
      p.deletedBarcodes = p.barcodes;
      p.barcodes = [];
      p.isActive = false;
      p.deletedAt = new Date();
      await p.save();
    } else {
      await Promise.all([
        Price.deleteMany({ shopId: shopId(req), productId: id }),
        PriceChange.deleteMany({ shopId: shopId(req), productId: id }),
        Stock.deleteMany({ shopId: shopId(req), productId: id }),
      ]);
      await repo(req, Product).deleteOne({ _id: id });
    }
    await audit(req, { action: 'product.deleted', entity: 'product', entityId: id, before, meta: { kept: used.some(Boolean) } });
    ok(res, { id: String(id), deleted: true });
  }),
);

productsRouter.post(
  '/:id/generate-barcode',
  idParams,
  requirePermission('products.manage'),
  h(async (req, res) => {
    const p = await repo(req, Product).findById(req.params.id);
    if (!p) throw notFound('PRODUCT_NOT_FOUND');
    const code = await nextInternalBarcode(req);
    p.barcodes.push(code);
    await p.save();
    await audit(req, { action: 'product.barcode_generated', entity: 'product', entityId: p._id, meta: { code } });
    ok(res, present(req, p));
  }),
);
