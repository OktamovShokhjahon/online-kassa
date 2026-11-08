import iconv from 'iconv-lite';

export interface PrinterProfile {
  connection?: 'usb' | 'serial' | 'network';
  printerName?: string;
  host?: string;
  port?: number;
  paperWidthMm?: number;
  /** 384 dots for 58 mm paper (Xprinter XP-58IIL), 576 for 80 mm. */
  printWidthDots?: number;
  /** Characters per line in font A: 32 for 58 mm, 48 for 80 mm. */
  charsPerLine?: number;
  codePage?: 'CP866' | 'CP437' | 'CP1251' | 'WPC1252';
  cutEnabled?: boolean;
  drawerEnabled?: boolean;
}

export const DEFAULT_PROFILE: Required<Pick<PrinterProfile, 'paperWidthMm' | 'printWidthDots' | 'charsPerLine' | 'codePage' | 'cutEnabled' | 'drawerEnabled'>> = {
  paperWidthMm: 58,
  printWidthDots: 384,
  charsPerLine: 32,
  codePage: 'CP866',
  cutEnabled: false,
  drawerEnabled: false,
};

/** `ESC t n` page numbers for common Chinese ESC/POS firmwares (Xprinter XP-58IIL: 17 = PC866). */
const CODE_PAGE_NUMBER: Record<string, number> = { CP437: 0, WPC1252: 16, CP866: 17, CP1251: 46 };
const ICONV_NAME: Record<string, string> = { CP437: 'cp437', WPC1252: 'win1252', CP866: 'cp866', CP1251: 'win1251' };

const ESC = 0x1b;
const GS = 0x1d;

/** Uzbek o‘ g‘ and the ʼ sign are printed with the ASCII apostrophe (printers have no such glyphs). */
export function normalizeText(s: string): string {
  return s
    .replace(/[‘’ʻʼʽ`´′ʹ]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ');
}

export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of normalizeText(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

/** `left .... right` on one line of exactly `width` characters (left is truncated, never right). */
export function twoColumns(left: string, right: string, width: number): string {
  const l = normalizeText(left);
  const r = normalizeText(right);
  const room = width - r.length - 1;
  const lt = l.length > room ? l.slice(0, Math.max(0, room)) : l;
  return lt + ' '.repeat(Math.max(1, width - lt.length - r.length)) + r;
}

/**
 * Minimal ESC/POS byte builder. Everything the POS asks for is rendered here from structured
 * data, so the browser never produces raw printer bytes. `preview` mirrors what is printed as text.
 */
export class EscPos {
  private chunks: Buffer[] = [];
  readonly preview: string[] = [];
  readonly width: number;
  private enc: string;

  constructor(readonly profile: PrinterProfile = {}) {
    const p = { ...DEFAULT_PROFILE, ...profile };
    this.width = p.charsPerLine;
    this.enc = ICONV_NAME[p.codePage] ?? 'cp866';
    this.raw(ESC, 0x40); // initialize
    this.raw(ESC, 0x74, CODE_PAGE_NUMBER[p.codePage] ?? 17); // character code table
  }

  raw(...bytes: number[]) { this.chunks.push(Buffer.from(bytes)); return this; }
  rawBuf(b: Buffer) { this.chunks.push(b); return this; }

  align(a: 'left' | 'center' | 'right') { return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2); }
  bold(on: boolean) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  /** 1 = normal, 2 = double. */
  size(w: 1 | 2 | 3, h: 1 | 2 | 3) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }

  /** Encodes with the profile's code page; unmappable characters become '?'. */
  encode(text: string): Buffer {
    return iconv.encode(normalizeText(text), this.enc);
  }

  /** Prints one logical line (already laid out to the paper width). */
  line(text = '') {
    this.preview.push(text);
    this.chunks.push(this.encode(text), Buffer.from([0x0a]));
    return this;
  }
  lines(text: string, align: 'left' | 'center' | 'right' = 'left') {
    this.align(align);
    for (const l of wrapText(text, this.width)) this.line(l);
    return this.align('left');
  }
  sep(ch = '-') { return this.line(ch.repeat(this.width)); }
  row(left: string, right: string) { return this.line(twoColumns(left, right, this.width)); }
  center(text: string) { this.align('center'); this.line(text.slice(0, this.width)); return this.align('left'); }
  feed(n = 3) { for (let i = 0; i < n; i++) this.preview.push(''); return this.raw(ESC, 0x64, n); }

  /** Partial cut with feed. Only sent when the terminal's printer profile enables it. */
  cut() { return this.raw(GS, 0x56, 0x42, 0x00); }

  /** Drawer kick pulse on pin 2 (ESC p). Only when enabled in the profile. */
  openDrawer() { return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa); }

  /** Native QR code (GS ( k). `size` is the module size in dots (1-16). */
  qr(data: string, size = 6) {
    const bytes = Buffer.from(data, 'utf8');
    const len = bytes.length + 3;
    this.align('center');
    this.raw(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, size))); // module size
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // error correction M
    this.raw(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30).rawBuf(bytes); // store
    this.raw(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
    this.preview.push(`[QR ${data.length > 40 ? data.slice(0, 40) + '…' : data}]`);
    return this.align('left');
  }

  /** Native 1D barcode: EAN-13 when valid, otherwise Code 128 (set B). */
  barcode(code: string, height = 60) {
    this.align('center');
    this.raw(GS, 0x68, height); // height
    this.raw(GS, 0x77, 2); // module width
    this.raw(GS, 0x48, 2); // human-readable text below
    if (/^\d{13}$/.test(code)) this.raw(GS, 0x6b, 0x43, 13).rawBuf(Buffer.from(code, 'ascii'));
    else {
      const data = Buffer.from('{B' + code.replace(/[^\x20-\x7e]/g, '?'), 'ascii');
      this.raw(GS, 0x6b, 0x49, data.length).rawBuf(data);
    }
    this.preview.push(`[BARCODE ${code}]`);
    return this.align('left');
  }

  /** Raster image (GS v 0) from a 1-bit bitmap: rows of bytes, 8 pixels per byte, MSB first. */
  raster(widthBytes: number, heightDots: number, bitmap: Buffer) {
    this.raw(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, heightDots & 0xff, (heightDots >> 8) & 0xff).rawBuf(bitmap);
    this.preview.push(`[IMAGE ${widthBytes * 8}x${heightDots}]`);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
