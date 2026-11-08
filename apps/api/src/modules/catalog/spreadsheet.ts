import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { IMPORT_FIELDS, type ImportMapping } from '@kass/shared';
import { badRequest } from '../../lib/errors';

export interface ParsedSheet {
  columns: string[];
  rows: string[][];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.richText) return o.richText.map((r: any) => r.text).join('').trim();
    if (o.result !== undefined) return String(o.result).trim(); // formula
    if (o.text !== undefined) return String(o.text).trim(); // hyperlink
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Reads the first sheet of an .xlsx or a .csv (comma, semicolon or tab separated). */
export async function parseSpreadsheet(buffer: Buffer, filename: string): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename)) {
      const head = buffer.toString('utf8', 0, 2000).split(/\r?\n/)[0] ?? '';
      const delimiter = [';', '\t', ','].sort((a, b) => head.split(b).length - head.split(a).length)[0];
      await wb.csv.read(Readable.from(buffer.toString('utf8').replace(/^﻿/, '')), { parserOptions: { delimiter } });
    } else if (/\.xlsx$/i.test(filename)) {
      await wb.xlsx.load(buffer as any);
    } else {
      throw badRequest('IMPORT_FILE_INVALID');
    }
  } catch (e: any) {
    if (e?.code === 'IMPORT_FILE_INVALID') throw e;
    throw badRequest('IMPORT_FILE_INVALID');
  }
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) throw badRequest('IMPORT_FILE_INVALID');
  const all: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) values.push(cellText(row.getCell(c).value));
    all.push(values);
  });
  if (all.length < 1) throw badRequest('IMPORT_FILE_INVALID');
  const columns = all[0].map((c, i) => c || `Column ${i + 1}`);
  const rows = all.slice(1).filter((r) => r.some((c) => c !== ''));
  return { columns, rows };
}

const SYNONYMS: Record<keyof ImportMapping, string[]> = {
  name: ['name', 'nomi', 'nom', 'mahsulot', 'product', 'наименование', 'название', 'товар', 'номи'],
  sku: ['sku', 'article', 'artikul', 'артикул', 'код'],
  barcode: ['barcode', 'barcodes', 'shtrix', 'штрихкод', 'штрих-код', 'ean', 'шк'],
  category: ['category', 'kategoriya', 'категория', 'group', 'guruh', 'группа'],
  unit: ['unit', 'birlik', 'ед', 'единица', 'ед.изм', 'o\'lchov'],
  price: ['price', 'narx', 'цена', 'sotuv narxi', 'retail'],
  vatRate: ['vat', 'qqs', 'ндс', 'tax'],
  mxikCode: ['mxik', 'ikpu', 'икпу', 'ихик', 'mxik code'],
  packageCode: ['package', 'packagecode', 'qadoq', 'упаковка', 'код упаковки', 'package code'],
  isMarked: ['marked', 'markirovka', 'маркировка', 'markalangan'],
  isWeighted: ['weighted', 'weight', 'vaznli', 'весовой', 'вес'],
};

/** Best-effort column auto-mapping by header name (en/ru/uz). */
export function suggestMapping(columns: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  for (const field of IMPORT_FIELDS) {
    const hit = columns.find((c) => SYNONYMS[field].includes(c.toLowerCase().trim()));
    if (hit) mapping[field] = hit;
  }
  return mapping;
}

export async function buildWorkbookBuffer(
  sheetName: string,
  header: string[],
  rows: Array<Array<string | number | boolean | null>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(header).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns.forEach((col, i) => {
    const longest = Math.max(header[i]?.length ?? 8, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length));
    col.width = Math.min(60, Math.max(10, longest + 2));
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
