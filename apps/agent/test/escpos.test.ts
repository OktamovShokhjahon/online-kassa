import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { amount, renderLabels, renderReceipt, renderReport, renderTestPage, type ReceiptData } from '../src/render';
import { EscPos, normalizeText, twoColumns, wrapText } from '../src/escpos';

const labels = { receipt: 'ЧЕК', copy: '*** КОПИЯ ***', refund: 'ЧЕК ВОЗВРАТА', number: '№', date: 'Дата', cashier: 'Кассир', terminal: 'Касса', customer: 'Клиент', subtotal: 'Сумма', discount: 'Скидка', promotion: 'Акция', vat: 'НДС', total: 'ИТОГО', cash: 'Наличные', card: 'Карта', cashGiven: 'Получено', change: 'Сдача', bonusBalance: 'Баланс бонусов', bonusEarned: 'Начислено', fiscalSign: 'Фискальный признак', fiscalModule: 'Фискальный модуль', thanks: 'Спасибо за покупку!', mxik: 'ИКПУ' };
const receipt = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  type: 'sale', language: 'ru', labels, currency: 'UZS',
  shop: { name: "Do‘kon “Мой магазин”", tin: '123456789' }, branch: { name: 'Чиланзар', address: 'ул. Катартал, 12', phone: '+998 71 200 00 00' },
  header: 'Добро пожаловать', footer: 'Обмен в течение 14 дней', number: '1-000123', createdAt: '06.11.2026 14:02:11', cashier: 'Алишер', terminal: 'Касса 1',
  lines: [
    { name: 'Колбаса докторская вареная высший сорт охлажденная 400 г в упаковке', qty: 2, price: 4_500_000, discount: 0, total: 9_000_000, unit: 'piece' },
    { name: 'Кола 1л', qty: 1.5, price: 1_200_000, discount: 180_000, promotion: 'Кола -10%', total: 1_620_000 },
  ],
  subtotal: 10_800_000, discount: 180_000, vat: [{ rate: 12, amount: 1_114_286 }], total: 10_620_000,
  payments: [{ method: 'cash', label: 'Наличные', amount: 10_620_000 }], cashGiven: 11_000_000, change: 380_000, qr: '1-000123', ...over,
});
const has = (buf: Buffer, bytes: number[]) => buf.includes(Buffer.from(bytes));
const textLines = (p: EscPos) => p.preview.filter((l) => !l.startsWith('['));

describe('ESC/POS layout for a 58 mm printer (spec 9.6)', () => {
  const profile = { charsPerLine: 32, codePage: 'CP866' as const };

  it('never prints a line wider than 32 characters, in any language', () => {
    for (const lang of ['ru', 'uz', 'en'] as const) {
      const p = renderReceipt(receipt({ language: lang }), profile);
      for (const l of textLines(p)) expect(l.length, `"${l}"`).toBeLessThanOrEqual(32);
    }
  });

  it('initialises the printer and selects the Cyrillic code page (PC866)', () => {
    const buf = renderReceipt(receipt(), profile).toBuffer();
    expect([...buf.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 17]);
  });

  it('encodes Cyrillic with CP866 and Latin/Uzbek text as plain ASCII', () => {
    const buf = renderReceipt(receipt(), profile).toBuffer();
    expect(buf.includes(iconv.encode('Спасибо за покупку!', 'cp866'))).toBe(true);
    expect(buf.includes(iconv.encode('Кассир', 'cp866'))).toBe(true);
    // Uzbek o‘ g‘ ʼ and typographic quotes are printed with ASCII characters
    expect(normalizeText("o‘zbek g‘isht ʼ “q”")).toBe('o\'zbek g\'isht \' "q"');
    expect(buf.includes(Buffer.from("Do'kon", 'ascii'))).toBe(true);
    const uz = renderReceipt(receipt({ language: 'uz', labels: { ...labels, total: 'JAMI' } }), profile).toBuffer();
    expect(uz.includes(Buffer.from('JAMI', 'ascii'))).toBe(true);
  });

  it('lays out product names on at most 2 lines and aligns amounts to the right edge', () => {
    const p = renderReceipt(receipt(), profile);
    const t = textLines(p);
    const i = t.findIndex((l) => l.startsWith('Колбаса'));
    expect(t[i].length).toBeLessThanOrEqual(32);
    expect(t[i + 2]).toMatch(/^ {2}2 x 45 000 +90 000$/); // qty x price ... total
    expect(t[i + 2]).toHaveLength(32);
    expect(t.some((l) => /^ {2}1\.5 x 12 000 +18 000$/.test(l))).toBe(true);
    expect(t.some((l) => l.includes('Акция: Кола -10%') && l.endsWith('-1 800'))).toBe(true);
    const total = t.find((l) => l.startsWith('ИТОГО'))!;
    expect(total).toHaveLength(32);
    expect(total.endsWith('106 200 сум')).toBe(true);
    expect(t.find((l) => l.startsWith('Сдача'))!.endsWith('3 800')).toBe(true);
    expect(t.find((l) => l.startsWith('НДС 12%'))!.endsWith('11 143')).toBe(true);
  });

  it('cuts and kicks the drawer only when the printer profile enables them', () => {
    const cash = renderReceipt(receipt(), { ...profile, cutEnabled: false, drawerEnabled: false }).toBuffer();
    expect(has(cash, [0x1d, 0x56])).toBe(false);
    expect(has(cash, [0x1b, 0x70])).toBe(false);
    const on = renderReceipt(receipt(), { ...profile, cutEnabled: true, drawerEnabled: true }).toBuffer();
    expect(has(on, [0x1d, 0x56, 0x42, 0x00])).toBe(true);
    expect(has(on, [0x1b, 0x70, 0x00, 0x19, 0xfa])).toBe(true);
    // a card-only receipt does not open the drawer
    const card = renderReceipt(receipt({ payments: [{ method: 'card', amount: 10_620_000 }], cashGiven: 0, change: 0 }), { ...profile, drawerEnabled: true }).toBuffer();
    expect(has(card, [0x1b, 0x70])).toBe(false);
    // the drawer pulse is sent before any text
    expect(on.indexOf(Buffer.from([0x1b, 0x70, 0x00]))).toBeLessThan(on.indexOf(iconv.encode('ИТОГО', 'cp866')));
  });

  it('prints the receipt-number QR and the fiscal block with its QR code', () => {
    const plain = renderReceipt(receipt(), profile).toBuffer();
    expect(has(plain, [0x1d, 0x28, 0x6b])).toBe(true); // GS ( k  QR
    expect(plain.includes(Buffer.from('1-000123'))).toBe(true);
    const f = renderReceipt(receipt({ fiscal: { sign: '123456789012', moduleId: 'MOD-77', receiptId: 'AB12CD', qr: 'https://ofd.example/check?r=AB12CD' } }), profile);
    const buf = f.toBuffer();
    expect(buf.includes(Buffer.from('https://ofd.example/check?r=AB12CD'))).toBe(true);
    expect(buf.includes(iconv.encode('Фискальный признак: 123456789012', 'cp866')) || textLines(f).some((l) => l.includes('123456789012'))).toBe(true);
    expect(textLines(f).some((l) => l.includes('MOD-77'))).toBe(true);
  });

  it('marks reprints as a copy and refunds as return receipts', () => {
    expect(textLines(renderReceipt(receipt({ copy: true }), profile))[0]).toContain('КОПИЯ');
    const refund = textLines(renderReceipt(receipt({ type: 'refund', originalNumber: '1-000001' }), profile));
    expect(refund.some((l) => l.includes('ЧЕК ВОЗВРАТА'))).toBe(true);
    expect(refund.some((l) => l.includes('1-000001'))).toBe(true);
  });

  it('shows bonus information only for an attached customer', () => {
    const p = textLines(renderReceipt(receipt({ customer: { name: 'Али', phone: '+998901234567' }, bonusEarned: 21_240, bonusBalance: 54_000 }), profile));
    expect(p.some((l) => l.startsWith('Начислено'))).toBe(true);
    expect(p.some((l) => l.startsWith('Баланс бонусов') && l.endsWith('540'))).toBe(true);
    expect(textLines(renderReceipt(receipt(), profile)).some((l) => l.startsWith('Начислено'))).toBe(false);
  });

  it('adapts to an 80 mm printer (48 characters)', () => {
    const p = renderReceipt(receipt(), { charsPerLine: 48, paperWidthMm: 80, codePage: 'CP866' });
    expect(Math.max(...textLines(p).map((l) => l.length))).toBeLessThanOrEqual(48);
    expect(textLines(p).find((l) => l.startsWith('ИТОГО'))).toHaveLength(48);
  });

  it('USD amounts use two decimals', () => {
    expect(amount(123_456, 'USD')).toBe('1 234.56');
    expect(amount(12_500_000, 'UZS')).toBe('125 000');
    expect(amount(-50_000, 'UZS')).toBe('-500');
  });
});

describe('text helpers', () => {
  it('wraps on words and splits very long words', () => {
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrapText('x'.repeat(70), 32).map((l) => l.length)).toEqual([32, 32, 6]);
    expect(twoColumns('Left', 'Right', 20)).toBe('Left' + ' '.repeat(11) + 'Right');
    expect(twoColumns('A very very long left column text', '99', 16)).toHaveLength(16);
  });
});

describe('reports, labels and test page', () => {
  const report = {
    type: 'z_report' as const, language: 'en' as const, labels: { ...labels, zReport: 'Z-REPORT', xReport: 'X-REPORT', opened: 'Opened', closed: 'Closed', receipts: 'Receipts', sales: 'Sales', returns: 'Returns', openingCash: 'Opening cash', cashIn: 'Cash in', cashOut: 'Cash out', expectedCash: 'Expected cash', countedCash: 'Counted cash', difference: 'Difference' },
    currency: 'UZS' as const, shop: { name: 'Shop' }, branch: { name: 'Main' }, terminal: 'Kassa 1', cashier: 'Ali', openedAt: '06.11.2026 09:00:00', closedAt: '06.11.2026 21:00:00',
    totals: { receipts: 12, gross: 5_000_000, discount: 0, net: 5_000_000, byMethod: { cash: 3_000_000, card: 2_000_000, bonus: 0, credit: 0 }, refunds: { count: 1, total: 300_000, cash: 300_000, card: 0, debt: 0 }, cashIn: 50_000, cashOut: 20_000, debtRepayments: { cash: 0, card: 0 }, openingCash: 100_000, expectedCash: 2_830_000 },
    countedCash: 2_800_000, difference: -30_000,
  };
  it('prints the Z-report with expected cash, counted cash and the difference', () => {
    const t = textLines(renderReport(report, { charsPerLine: 32 }));
    expect(t.some((l) => l.includes('Z-REPORT'))).toBe(true);
    expect(t.find((l) => l.startsWith('Expected cash'))!.endsWith('28 300')).toBe(true);
    expect(t.find((l) => l.startsWith('Difference'))!.endsWith('-300')).toBe(true);
    for (const l of t) expect(l.length).toBeLessThanOrEqual(32);
  });
  it('prints price labels with a native EAN-13 barcode', () => {
    const buf = renderLabels([{ name: 'Cola 1L', price: 1_200_000, barcode: '4006381333931', quantity: 2 }], { cutEnabled: true }).toBuffer();
    expect(has(buf, [0x1d, 0x6b, 0x43, 13])).toBe(true);
    expect(buf.includes(Buffer.from('4006381333931'))).toBe(true);
    expect(buf.toString('latin1').split('\x1dV').length - 1).toBe(2); // one cut per label copy
    const code128 = renderLabels([{ name: 'X', price: null, barcode: 'ABC-1' }]).toBuffer();
    expect(has(code128, [0x1d, 0x6b, 0x49])).toBe(true);
  });
  it('the test page exercises Latin, Cyrillic and Uzbek characters within the width', () => {
    const p = renderTestPage({ charsPerLine: 32 }, { terminal: 'Kassa 1', version: '1.0.0' });
    expect(p.toBuffer().includes(iconv.encode('АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.slice(0, 32), 'cp866'))).toBe(true);
    for (const l of textLines(p)) expect(l.length).toBeLessThanOrEqual(32);
  });
});
