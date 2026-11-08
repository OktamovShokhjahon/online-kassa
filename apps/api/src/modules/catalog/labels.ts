import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { barcodeModules, formatMoney, type Currency, type Language } from '@kass/shared';

export interface LabelItem {
  name: string;
  price: number | null;
  barcode: string | null;
  copies: number;
}

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};
export const translit = (s: string) =>
  s
    .split('')
    .map((ch) => {
      const lower = ch.toLowerCase();
      const t = CYR[lower];
      if (t === undefined) return ch;
      return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join('');

/**
 * Optional Unicode font for Cyrillic product names: set LABEL_FONT_PATH or drop an OFL font
 * (e.g. Noto Sans / DejaVu Sans) at apps/api/assets/fonts/label.ttf. Without it the standard
 * PDF font is used and Cyrillic names are transliterated so the PDF never shows garbage.
 */
export function findLabelFont(): string | null {
  const candidates = [process.env.LABEL_FONT_PATH, path.resolve(__dirname, '../../../assets/fonts/label.ttf'), path.resolve(process.cwd(), 'assets/fonts/label.ttf')];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/** A4 sheet of 3x8 labels (70 x 37 mm): name, branch price and a scannable barcode. */
export function renderLabelsPdf(items: LabelItem[], currency: Currency, lang: Language): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
  const fontPath = findLabelFont();
  if (fontPath) {
    doc.registerFont('label', fontPath);
    doc.font('label');
  } else {
    doc.font('Helvetica');
  }
  const txt = (s: string) => (fontPath ? s : translit(s));

  const mm = 72 / 25.4;
  const cols = 3;
  const rows = 8;
  const w = 70 * mm;
  const h = 37 * mm;
  const left = (595.28 - cols * w) / 2;
  const top = (841.89 - rows * h) / 2;

  const flat: LabelItem[] = items.flatMap((i) => Array.from({ length: i.copies }, () => i));
  flat.forEach((item, idx) => {
    const slot = idx % (cols * rows);
    if (idx > 0 && slot === 0) doc.addPage();
    const x = left + (slot % cols) * w;
    const y = top + Math.floor(slot / cols) * h;

    doc.save();
    doc.fillColor('#000').fontSize(8).text(txt(item.name).slice(0, 48), x + 4 * mm, y + 3 * mm, { width: w - 8 * mm, height: 8 * mm, ellipsis: true });
    doc.fontSize(15).text(item.price === null ? '-' : formatMoney(item.price, currency, lang), x + 4 * mm, y + 11 * mm, { width: w - 8 * mm });
    if (item.barcode) drawBarcode(doc, item.barcode, x + 4 * mm, y + 19 * mm, w - 8 * mm, 10 * mm);
    doc.restore();
  });
  return doc;
}

type Doc = InstanceType<typeof PDFDocument>;

/** Scannable 1D barcode (EAN-13 or Code 128) with its digits underneath, centred in `width`. */
export function drawBarcode(doc: Doc, code: string, x: number, y: number, width: number, height: number) {
  try {
    const { modules } = barcodeModules(code);
    const barW = Math.min(width / modules.length, 0.9);
    const startX = x + (width - modules.length * barW) / 2;
    let run = 0;
    for (let i = 0; i <= modules.length; i++) {
      if (modules[i] === 1) run++;
      else if (run) {
        doc.rect(startX + (i - run) * barW, y, run * barW, height).fill('#000');
        run = 0;
      }
    }
    doc.fillColor('#000').fontSize(7).text(code, x, y + height + 1.5, { width, align: 'center', lineBreak: false });
  } catch {
    doc.fillColor('#000').fontSize(7).text(code, x, y + height / 2, { width, align: 'center', lineBreak: false });
  }
}

/** QR code drawn as vector squares (sharp at any print size). */
export function drawQr(doc: Doc, value: string, x: number, y: number, size: number) {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell + 0.05, cell + 0.05).fill('#000');
    }
  }
}

export interface CodeItem {
  name: string;
  code: string;
}

/**
 * Printable A4 sheet of every product's code for cutting: QR codes 4 x 6 per page, barcodes 3 x 8.
 * Each cell has the code, the product name and the code digits; light grey lines guide the cut.
 */
export function renderCodesPdf(items: CodeItem[], kind: 'qr' | 'barcode', title: string): Doc {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, info: { Title: title } });
  const fontPath = findLabelFont();
  if (fontPath) {
    doc.registerFont('label', fontPath);
    doc.font('label');
  } else doc.font('Helvetica');
  const txt = (s: string) => (fontPath ? s : translit(s));

  const mm = 72 / 25.4;
  const [cols, rows] = kind === 'qr' ? [4, 6] : [3, 8];
  const w = kind === 'qr' ? 48 * mm : 66 * mm;
  const h = kind === 'qr' ? 46 * mm : 34 * mm;
  const left = (595.28 - cols * w) / 2;
  const top = (841.89 - rows * h) / 2;

  items.forEach((item, idx) => {
    const slot = idx % (cols * rows);
    if (idx > 0 && slot === 0) doc.addPage();
    const x = left + (slot % cols) * w;
    const y = top + Math.floor(slot / cols) * h;
    doc.save();
    doc.lineWidth(0.3).strokeColor('#d0d7d6').rect(x, y, w, h).stroke();
    if (kind === 'qr') {
      const size = 28 * mm;
      drawQr(doc, item.code, x + (w - size) / 2, y + 3 * mm, size);
      doc.fillColor('#000').fontSize(7).text(txt(item.name), x + 2.5 * mm, y + 32.5 * mm, { width: w - 5 * mm, height: 7 * mm, align: 'center', ellipsis: true });
      doc.fillColor('#555').fontSize(6.5).text(item.code, x + 2.5 * mm, y + 40.5 * mm, { width: w - 5 * mm, align: 'center', lineBreak: false });
    } else {
      doc.fillColor('#000').fontSize(8).text(txt(item.name), x + 4 * mm, y + 3 * mm, { width: w - 8 * mm, height: 8 * mm, ellipsis: true });
      drawBarcode(doc, item.code, x + 4 * mm, y + 12 * mm, w - 8 * mm, 14 * mm);
    }
    doc.restore();
  });
  if (!items.length) doc.fontSize(12).fillColor('#000').text('-', 40, 40);
  return doc;
}
