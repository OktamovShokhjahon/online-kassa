import { EscPos, normalizeText, wrapText, type PrinterProfile } from './escpos';

/* Structured data coming from the POS / server (see apps/api receipt.ts). */
export interface ReceiptData {
  type: 'sale' | 'refund';
  language: 'uz' | 'ru' | 'en';
  copy?: boolean;
  labels: Record<string, string>;
  currency: 'UZS' | 'USD' | 'RUB';
  shop: { name: string; logoUrl?: string | null; tin?: string | null };
  branch: { name?: string; address?: string; phone?: string };
  header?: string;
  footer?: string;
  number: string;
  originalNumber?: string;
  createdAt: string;
  cashier?: string;
  terminal?: string;
  customer?: { name: string; phone: string; bonusBalance?: number } | null;
  lines: Array<{ name: string; qty: number; unit?: string | null; price: number; discount: number; promotion?: string | null; total: number; mxikCode?: string | null }>;
  subtotal: number;
  discount: number;
  vat?: Array<{ rate: number; amount: number }>;
  total: number;
  payments: Array<{ method: string; label?: string; amount: number }>;
  cashGiven?: number;
  change?: number;
  bonusEarned?: number;
  bonusBalance?: number | null;
  fiscal?: { sign: string; moduleId?: string; receiptId?: string; qr?: string } | null;
  qr?: string;
}

export interface ReportData {
  type: 'x_report' | 'z_report';
  language: 'uz' | 'ru' | 'en';
  labels: Record<string, string>;
  currency: 'UZS' | 'USD' | 'RUB';
  shop: { name: string };
  branch: { name?: string };
  terminal?: string;
  cashier?: string;
  openedAt: string;
  closedAt?: string | null;
  totals: {
    receipts: number; gross: number; discount: number; net: number;
    byMethod: { cash: number; card: number; bonus: number; credit: number };
    refunds: { count: number; total: number; cash: number; card: number; debt: number };
    cashIn: number; cashOut: number; debtRepayments: { cash: number; card: number };
    openingCash: number; expectedCash: number;
  };
  countedCash?: number | null;
  difference?: number | null;
}

export interface LabelData {
  name: string;
  price: number | null;
  barcode?: string | null;
  quantity?: number;
  currency?: 'UZS' | 'USD' | 'RUB';
}

/** `12 500` for UZS (minor units are tiyin), `12.50` for USD/RUB - no currency sign. */
export function amount(minor: number, currency: string): string {
  const negative = minor < 0;
  const major = Math.abs(minor) / 100;
  const body = currency === 'UZS' ? String(Math.round(major)) : major.toFixed(2);
  const [i, f] = body.split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (negative ? '-' : '') + grouped + (f ? '.' + f : '');
}

const CUR_SUFFIX: Record<string, Record<string, string>> = {
  UZS: { uz: "so'm", ru: 'сум', en: 'UZS' },
  USD: { uz: 'USD', ru: 'USD', en: 'USD' },
  RUB: { uz: 'RUB', ru: 'руб', en: 'RUB' },
};
const withCur = (minor: number, cur: string, lang: string) => `${amount(minor, cur)} ${CUR_SUFFIX[cur]?.[lang] ?? cur}`;

const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));

/** Renders a sale or refund receipt for a 58 mm (32 chars) or 80 mm printer (spec 7.3, 9.6). */
export function renderReceipt(r: ReceiptData, profile: PrinterProfile = {}): EscPos {
  const p = new EscPos(profile);
  const L = r.labels;
  const cur = r.currency;
  const hasCash = r.payments.some((x) => x.method === 'cash' && x.amount > 0);

  // Drawer first: it opens while the receipt is still printing.
  if (profile.drawerEnabled && r.type === 'sale' && hasCash) p.openDrawer();

  if (r.copy) p.center(L.copy ?? '*** COPY ***');
  p.align('center').bold(true).size(2, 2);
  for (const l of wrapText(r.shop.name, Math.floor(p.width / 2))) p.line(l);
  p.size(1, 1).bold(false).align('left');
  if (r.branch.name) p.lines(r.branch.name, 'center');
  if (r.branch.address) p.lines(r.branch.address, 'center');
  if (r.branch.phone) p.lines(r.branch.phone, 'center');
  if (r.shop.tin) p.lines(`${L.tin ?? 'TIN'}: ${r.shop.tin}`, 'center');
  if (r.header) p.lines(r.header, 'center');
  p.sep();

  p.bold(true).center(r.type === 'refund' ? L.refund ?? 'REFUND' : L.receipt ?? 'RECEIPT').bold(false);
  p.row(`${L.number ?? 'No'}:`, r.number);
  if (r.originalNumber) p.row(`${L.receipt ?? 'Receipt'}:`, r.originalNumber);
  p.row(`${L.date ?? 'Date'}:`, r.createdAt);
  if (r.cashier) p.row(`${L.cashier ?? 'Cashier'}:`, r.cashier);
  if (r.terminal) p.row(`${L.terminal ?? 'Terminal'}:`, r.terminal);
  if (r.customer) p.lines(`${L.customer ?? 'Customer'}: ${r.customer.name} ${r.customer.phone}`);
  p.sep();

  for (const l of r.lines) {
    // product names take up to 2 lines of the paper width (spec 5.4)
    for (const n of wrapText(l.name, p.width).slice(0, 2)) p.line(n);
    p.row(`  ${qtyText(l.qty)} x ${amount(l.price, cur)}`, amount(l.qty * l.price, cur));
    if (l.discount > 0) p.row(`  ${l.promotion ? `${L.promotion ?? 'Promo'}: ${l.promotion}` : L.discount ?? 'Discount'}`, `-${amount(l.discount, cur)}`);
    if (l.discount > 0) p.row('', amount(l.total, cur));
    if (l.mxikCode) p.line(`  ${L.mxik ?? 'MXIK'} ${l.mxikCode}`);
  }
  p.sep();

  if (r.discount > 0) {
    p.row(L.subtotal ?? 'Subtotal', amount(r.subtotal, cur));
    p.row(L.discount ?? 'Discount', `-${amount(r.discount, cur)}`);
  }
  for (const v of r.vat ?? []) p.row(`${L.vat ?? 'VAT'} ${v.rate}%`, amount(v.amount, cur));
  p.bold(true).size(1, 2);
  p.row(L.total ?? 'TOTAL', withCur(r.total, cur, r.language));
  p.size(1, 1).bold(false);
  p.sep();

  for (const pay of r.payments) p.row(pay.label ?? L[pay.method] ?? pay.method, amount(pay.amount, cur));
  if (r.type === 'sale' && (r.cashGiven ?? 0) > 0 && (r.change ?? 0) > 0) {
    p.row(L.cashGiven ?? 'Given', amount(r.cashGiven!, cur));
    p.row(L.change ?? 'Change', amount(r.change!, cur));
  }
  if (r.customer && (r.bonusEarned ?? 0) > 0) p.row(L.bonusEarned ?? 'Bonus earned', amount(r.bonusEarned!, cur));
  if (r.customer && r.bonusBalance !== null && r.bonusBalance !== undefined) p.row(L.bonusBalance ?? 'Bonus balance', amount(r.bonusBalance, cur));

  if (r.fiscal?.sign) {
    p.sep();
    p.lines(`${L.fiscalSign ?? 'Fiscal sign'}: ${r.fiscal.sign}`);
    if (r.fiscal.moduleId) p.lines(`${L.fiscalModule ?? 'Fiscal module'}: ${r.fiscal.moduleId}`);
    if (r.fiscal.receiptId) p.lines(`${L.fiscalReceipt ?? 'Receipt'}: ${r.fiscal.receiptId}`);
    if (r.fiscal.qr) p.qr(r.fiscal.qr, 5);
  }

  p.sep();
  if (L.thanks) p.center(L.thanks);
  if (r.footer) p.lines(r.footer, 'center');
  if (r.qr) p.qr(r.qr, 6); // receipt number as QR: scanned at the till for a fast return
  p.feed(profile.cutEnabled ? 4 : 5);
  if (profile.cutEnabled) p.cut();
  return p;
}

/** X-report (shift totals, no closing) and Z-report (closing). */
export function renderReport(r: ReportData, profile: PrinterProfile = {}): EscPos {
  const p = new EscPos(profile);
  const L = r.labels;
  const cur = r.currency;
  const t = r.totals;
  p.align('center').bold(true).size(2, 1).line(normalizeText(r.shop.name).slice(0, Math.floor(p.width / 2))).size(1, 1);
  p.line(r.type === 'z_report' ? L.zReport ?? 'Z-REPORT' : L.xReport ?? 'X-REPORT').bold(false).align('left');
  if (r.branch.name) p.lines(r.branch.name, 'center');
  p.sep();
  if (r.terminal) p.row(`${L.terminal ?? 'Terminal'}:`, r.terminal);
  if (r.cashier) p.row(`${L.cashier ?? 'Cashier'}:`, r.cashier);
  p.row(`${L.opened ?? 'Opened'}:`, r.openedAt);
  if (r.closedAt) p.row(`${L.closed ?? 'Closed'}:`, r.closedAt);
  p.sep();
  p.row(L.receipts ?? 'Receipts', String(t.receipts));
  p.row(L.sales ?? 'Sales', amount(t.net, cur));
  if (t.discount > 0) p.row(L.discount ?? 'Discount', amount(t.discount, cur));
  p.row(L.cash ?? 'Cash', amount(t.byMethod.cash, cur));
  p.row(L.card ?? 'Card', amount(t.byMethod.card, cur));
  if (t.byMethod.bonus) p.row(L.bonus ?? 'Bonus', amount(t.byMethod.bonus, cur));
  if (t.byMethod.credit) p.row(L.credit ?? 'Credit', amount(t.byMethod.credit, cur));
  if (t.refunds.count) p.row(`${L.returns ?? 'Returns'} (${t.refunds.count})`, `-${amount(t.refunds.total, cur)}`);
  p.sep();
  p.row(L.openingCash ?? 'Opening cash', amount(t.openingCash, cur));
  if (t.cashIn) p.row(L.cashIn ?? 'Cash in', amount(t.cashIn, cur));
  if (t.cashOut) p.row(L.cashOut ?? 'Cash out', `-${amount(t.cashOut, cur)}`);
  if (t.debtRepayments.cash) p.row(L.debtRepayments ?? 'Debt repayments', amount(t.debtRepayments.cash, cur));
  p.bold(true).row(L.expectedCash ?? 'Expected cash', amount(t.expectedCash, cur)).bold(false);
  if (r.countedCash !== null && r.countedCash !== undefined) {
    p.row(L.countedCash ?? 'Counted cash', amount(r.countedCash, cur));
    p.bold(true).row(L.difference ?? 'Difference', amount(r.difference ?? 0, cur)).bold(false);
  }
  p.feed(profile.cutEnabled ? 4 : 5);
  if (profile.cutEnabled) p.cut();
  return p;
}

/** Price label(s) on the receipt roll: name, price, barcode. */
export function renderLabels(labels: LabelData[], profile: PrinterProfile = {}): EscPos {
  const p = new EscPos(profile);
  for (const l of labels) {
    for (let i = 0; i < (l.quantity ?? 1); i++) {
      p.lines(l.name, 'center');
      if (l.price !== null) p.align('center').bold(true).size(2, 2).line(amount(l.price, l.currency ?? 'UZS')).size(1, 1).bold(false).align('left');
      if (l.barcode) p.barcode(l.barcode, 50);
      p.feed(2);
      if (profile.cutEnabled) p.cut();
    }
  }
  return p;
}

/** Test page: prints Latin, Cyrillic and Uzbek text so the code page and width can be verified. */
export function renderTestPage(profile: PrinterProfile = {}, info: { terminal?: string; version?: string } = {}): EscPos {
  const p = new EscPos(profile);
  p.center('ONLINE KASS').center('TEST PRINT / ТЕСТ / SINOV');
  p.sep('=');
  p.line('0123456789'.repeat(4).slice(0, p.width));
  p.line('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, p.width));
  p.line('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.slice(0, p.width));
  p.line("O'zbekiston g'alaba o'g'il ʼ".slice(0, p.width));
  p.line('абвгдеёжзийклмнопрстуфхцчшщъыьэюя'.slice(0, p.width));
  p.sep('=');
  p.row('Width:', `${p.width} chars`);
  if (info.terminal) p.row('Terminal:', info.terminal);
  if (info.version) p.row('Agent:', info.version);
  p.qr('https://onlinekass.example/test', 5);
  p.feed(profile.cutEnabled ? 4 : 5);
  if (profile.cutEnabled) p.cut();
  return p;
}
