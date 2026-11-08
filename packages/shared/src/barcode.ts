/** Barcode helpers shared by the API (generation, labels) and the web app (preview, validation). */

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('EAN-13 needs 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function isValidEan8(code: string): boolean {
  if (!/^\d{8}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(code[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(code[7]);
}

/**
 * Internal barcode for products without a factory code (spec 5.4):
 * prefix `2` + 4-digit shop code + 7-digit sequence + EAN-13 check digit.
 */
export function buildInternalBarcode(shopCode: number, seq: number): string {
  if (shopCode < 0 || shopCode > 9999) throw new Error('shopCode out of range');
  if (seq < 0 || seq > 9_999_999) throw new Error('sequence out of range');
  const first12 = `2${String(shopCode).padStart(4, '0')}${String(seq).padStart(7, '0')}`;
  return first12 + ean13CheckDigit(first12);
}

/** Weight-embedded barcodes (prefix 2) are NOT used for internal product codes: they identify products. */
export const isInternalBarcode = (code: string) => /^2\d{12}$/.test(code) && isValidEan13(code);

/* ------------------------------------------------------------------------- EAN-13 bars */

const R_CODES = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const L_CODES = R_CODES.map((r) => r.split('').map((b) => (b === '1' ? '0' : '1')).join(''));
const G_CODES = R_CODES.map((r) => r.split('').reverse().join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** 95 modules (1 = bar, 0 = space) of an EAN-13 symbol, including guard patterns. */
export function ean13Modules(code: string): number[] {
  if (!isValidEan13(code)) throw new Error('Invalid EAN-13');
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 0; i < 6; i++) {
    const d = Number(code[i + 1]);
    bits += parity[i] === 'L' ? L_CODES[d] : G_CODES[d];
  }
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R_CODES[Number(code[i])];
  bits += '101';
  return bits.split('').map(Number);
}

/* ---------------------------------------------------------------------------- Code 128 */

const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
];
const C128_STOP = '2331112';
export const CODE128_PATTERNS = C128;

/** Modules of a Code 128 (subset B) symbol for printable ASCII text. */
export function code128bModules(text: string): number[] {
  if (!/^[\x20-\x7E]+$/.test(text)) throw new Error('Code128-B supports printable ASCII only');
  const codes = [104, ...text.split('').map((c) => c.charCodeAt(0) - 32)];
  const checksum = codes.reduce((s, c, i) => s + c * (i === 0 ? 1 : i), 0) % 103;
  codes.push(checksum);
  const widths = codes.map((c) => C128[c]).join('') + C128_STOP;
  const modules: number[] = [];
  widths.split('').forEach((w, i) => {
    for (let k = 0; k < Number(w); k++) modules.push(i % 2 === 0 ? 1 : 0);
  });
  return modules;
}

/** Picks the right symbology for a product barcode and returns its bars. */
export function barcodeModules(code: string): { symbology: 'EAN13' | 'CODE128'; modules: number[] } {
  if (isValidEan13(code)) return { symbology: 'EAN13', modules: ean13Modules(code) };
  return { symbology: 'CODE128', modules: code128bModules(code) };
}
