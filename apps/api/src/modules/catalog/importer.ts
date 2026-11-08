import type { Request } from 'express';
import mongoose from 'mongoose';
import { UNITS, toMinor, type ImportMapping, type Unit } from '@kass/shared';
import { repo, shopId } from '../../lib/http';
import { oid } from '../../lib/util';
import { Category, Product } from '../../models/catalog';
import { applyPrices } from './priceService';
import type { ParsedSheet } from './spreadsheet';

const TRUE = new Set(['1', 'true', 'yes', 'y', 'x', 'ha', 'да', '+']);
const UNIT_ALIASES: Record<string, Unit> = {
  piece: 'piece', pcs: 'piece', pc: 'piece', dona: 'piece', шт: 'piece', 'шт.': 'piece',
  kg: 'kg', кг: 'kg', kilogram: 'kg',
  g: 'gram', gr: 'gram', gram: 'gram', г: 'gram', гр: 'gram',
  l: 'litre', litre: 'litre', liter: 'litre', litr: 'litre', л: 'litre', литр: 'litre',
  m: 'metre', metre: 'metre', meter: 'metre', metr: 'metre', м: 'metre', метр: 'metre',
  pack: 'pack', upakovka: 'pack', уп: 'pack', упаковка: 'pack', 'уп.': 'pack',
};

export interface ImportOptions {
  mapping: ImportMapping;
  updateExisting: boolean;
  /** Branches that receive the `price` column. Empty = prices are ignored. */
  priceBranchIds: string[];
}

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  pricesSet: number;
  errors: Array<{ row: number; message: string }>;
}

const MAX_ERRORS = 500;

export async function runImport(req: Request, sheet: ParsedSheet, opts: ImportOptions, userId: any): Promise<ImportResult> {
  const result: ImportResult = { total: sheet.rows.length, created: 0, updated: 0, skipped: 0, pricesSet: 0, errors: [] };
  const err = (row: number, message: string) => {
    if (result.errors.length < MAX_ERRORS) result.errors.push({ row, message });
  };
  const colIndex = (name?: string) => (name ? sheet.columns.indexOf(name) : -1);
  const idx = Object.fromEntries(Object.entries(opts.mapping).map(([k, v]) => [k, colIndex(v)])) as Record<keyof ImportMapping, number>;
  const get = (row: string[], key: keyof ImportMapping) => (idx[key] >= 0 ? (row[idx[key]] ?? '').trim() : '');

  const products = repo(req, Product);
  const categories = repo(req, Category);

  // --- lookup tables for matching existing products (by barcode, then SKU)
  const existing = await products.find({}).select('barcodes sku').lean();
  const byBarcode = new Map<string, string>();
  const bySku = new Map<string, string>();
  for (const p of existing) {
    for (const b of p.barcodes ?? []) byBarcode.set(b, String(p._id));
    if (p.sku) bySku.set(p.sku, String(p._id));
  }

  // --- category tree cache: "parentId|name" -> id
  const catRows = await categories.find({}).select('name parentId depth path').lean();
  const catKey = (parent: string | null, name: string) => `${parent ?? ''}|${name.toLowerCase()}`;
  const catCache = new Map(catRows.map((c) => [catKey(c.parentId ? String(c.parentId) : null, c.name), { id: String(c._id), depth: c.depth as number, path: c.path as any[] }]));
  async function resolveCategory(pathText: string): Promise<string | null> {
    const parts = pathText.split('>').map((s) => s.trim()).filter(Boolean).slice(0, 3);
    type Node = { id: string; depth: number; path: any[] };
    let parent: Node | null = null as Node | null;
    for (const name of parts) {
      const key = catKey(parent?.id ?? null, name);
      let node = catCache.get(key);
      if (!node) {
        const depth: number = (parent?.depth ?? 0) + 1;
        const path: any[] = parent ? [...parent.path, oid(parent.id)] : [];
        const c = await categories.create({ name, parentId: parent ? oid(parent.id) : null, depth, path });
        node = { id: String(c._id), depth, path };
        catCache.set(key, node);
      }
      parent = node;
    }
    return parent?.id ?? null;
  }

  type Pending = { row: number; doc?: any; update?: any; id: string; price: number | null };
  const inserts: Pending[] = [];
  const updates: Pending[] = [];
  const canPrice = opts.priceBranchIds.length > 0 && idx.price >= 0;

  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    const rowNo = i + 2; // spreadsheet row number (header is row 1)
    const name = get(row, 'name');
    if (!name) {
      err(rowNo, 'Name is empty');
      continue;
    }
    const barcodes = [...new Set(get(row, 'barcode').split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean))];
    const sku = get(row, 'sku') || undefined;
    const matches = new Set<string>();
    for (const b of barcodes) if (byBarcode.has(b)) matches.add(byBarcode.get(b)!);
    if (sku && bySku.has(sku)) matches.add(bySku.get(sku)!);
    if (matches.size > 1) {
      err(rowNo, 'Barcode and SKU belong to different existing products');
      continue;
    }

    const fields: Record<string, unknown> = { name };
    const unitText = get(row, 'unit').toLowerCase();
    if (unitText) {
      const unit = UNIT_ALIASES[unitText] ?? ((UNITS as readonly string[]).includes(unitText) ? (unitText as Unit) : undefined);
      if (!unit) {
        err(rowNo, `Unknown unit "${unitText}"`);
        continue;
      }
      fields.unit = unit;
    }
    const vat = get(row, 'vatRate');
    if (vat) {
      const n = Number(vat.replace(',', '.').replace('%', ''));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        err(rowNo, `Invalid VAT "${vat}"`);
        continue;
      }
      fields.vatRate = n;
    }
    const mxik = get(row, 'mxikCode');
    if (mxik) {
      if (!/^\d{17}$/.test(mxik)) {
        err(rowNo, `MXIK code must have 17 digits ("${mxik}")`);
        continue;
      }
      fields.mxikCode = mxik;
    }
    const pkg = get(row, 'packageCode');
    if (pkg) {
      if (!/^\d{1,10}$/.test(pkg)) {
        err(rowNo, `Invalid package code "${pkg}"`);
        continue;
      }
      fields.packageCode = pkg;
    }
    if (get(row, 'isMarked')) fields.isMarked = TRUE.has(get(row, 'isMarked').toLowerCase());
    if (get(row, 'isWeighted')) fields.isWeighted = TRUE.has(get(row, 'isWeighted').toLowerCase());
    let price: number | null = null;
    const priceText = get(row, 'price');
    if (canPrice && priceText) {
      const n = Number(priceText.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0) {
        err(rowNo, `Invalid price "${priceText}"`);
        continue;
      }
      price = toMinor(n);
    }

    // Resolve (and create) the category only once the row is known to be valid.
    const catText = get(row, 'category');
    if (catText) fields.categoryId = oid((await resolveCategory(catText))!);

    const matchedId = [...matches][0];
    if (matchedId) {
      if (!opts.updateExisting) {
        result.skipped++;
        continue;
      }
      const update: any = { $set: fields };
      if (sku) update.$set.sku = sku;
      if (barcodes.length) update.$addToSet = { barcodes: { $each: barcodes } };
      updates.push({ row: rowNo, update, id: matchedId, price });
      barcodes.forEach((b) => byBarcode.set(b, matchedId));
    } else {
      const _id = new mongoose.Types.ObjectId();
      const doc = { _id, ...fields, sku, barcodes, isActive: true };
      inserts.push({ row: rowNo, doc, id: String(_id), price });
      barcodes.forEach((b) => byBarcode.set(b, String(_id)));
      if (sku) bySku.set(sku, String(_id));
    }
  }

  const failedRows = new Set<number>();
  const runBulk = async (list: Pending[], build: (p: Pending) => any) => {
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      try {
        await products.bulkWrite(chunk.map(build)); // unordered by default in repo.bulkWrite
      } catch (e: any) {
        const writeErrors = e?.writeErrors ?? e?.result?.writeErrors ?? [];
        if (!writeErrors.length) throw e;
        for (const we of writeErrors) {
          const index = we.index ?? we.err?.index;
          const p = chunk[index];
          if (p) {
            failedRows.add(p.row);
            err(p.row, /barcodes/.test(we.errmsg ?? '') ? 'Duplicate barcode' : /sku/.test(we.errmsg ?? '') ? 'Duplicate SKU' : String(we.errmsg ?? 'Write error'));
          }
        }
      }
    }
  };
  await runBulk(inserts, (p) => ({ insertOne: { document: p.doc } }));
  await runBulk(updates, (p) => ({ updateOne: { filter: { _id: oid(p.id) }, update: p.update } }));
  result.created = inserts.filter((p) => !failedRows.has(p.row)).length;
  result.updated = updates.filter((p) => !failedRows.has(p.row)).length;

  // --- prices for all selected branches (shop admin only; checked by the caller)
  if (canPrice) {
    const changes = [...inserts, ...updates]
      .filter((p) => p.price && !failedRows.has(p.row))
      .flatMap((p) => opts.priceBranchIds.map((b) => ({ productId: p.id, branchId: b, price: p.price as number })));
    for (let i = 0; i < changes.length; i += 2000) {
      const applied = await applyPrices({ shopId: shopId(req), userId, changes: changes.slice(i, i + 2000), source: 'import' });
      result.pricesSet += applied.length;
    }
  }
  result.errors.sort((a, b) => a.row - b.row);
  return result;
}
