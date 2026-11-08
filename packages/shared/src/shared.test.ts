import { describe, expect, it } from 'vitest';
import { flattenKeys, messages, translate } from './i18n';
import { formatMoney, lineTotal, percentOf } from './money';
import { normalizePhone } from './phone';
import { formatTashkent, tashkentDayRange, tashkentDateString } from './time';
import { createShopSchema } from './schemas/admin';
import { ADMIN_ONLY_PERMISSIONS, ROLE_GRANTABLE_PERMISSIONS, PERMISSIONS } from './constants';

describe('i18n parity (CI fails if a key is missing in any language)', () => {
  const en = flattenKeys(messages.en).sort();
  for (const lang of ['uz', 'ru'] as const) {
    it(`${lang} has exactly the English keys`, () => {
      expect(flattenKeys(messages[lang]).sort()).toEqual(en);
    });
  }
  it('has no empty strings', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      const walk = (t: any): void =>
        Object.values(t).forEach((v) => (typeof v === 'string' ? expect(v.trim()).not.toBe('') : walk(v)));
      walk(messages[lang]);
    }
  });
  it('interpolates params', () => {
    expect(translate('en', 'auth.graceWarning', { days: 2 })).toContain('2 day');
  });
});

describe('money', () => {
  it('formats UZS without decimals and with space separators', () => {
    expect(formatMoney(12_500_000, 'UZS', 'uz')).toBe("125 000 so'm");
  });
  it('formats USD with 2 decimals', () => {
    expect(formatMoney(123_456, 'USD', 'en')).toBe('$1 234.56');
  });
  it('handles negatives and rounding', () => {
    expect(formatMoney(-50_000, 'UZS', 'ru')).toBe('-500 сум');
    expect(percentOf(1999, 10)).toBe(200);
    expect(lineTotal(1.5, 3333)).toBe(5000);
  });
});

describe('phone', () => {
  it('normalises to E.164', () => {
    expect(normalizePhone('+998 90 123 45 67')).toBe('+998901234567');
    expect(normalizePhone('90 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('time (Asia/Tashkent, UTC+5)', () => {
  it('formats in Tashkent time', () => {
    expect(formatTashkent(new Date('2026-11-06T19:30:00Z'))).toBe('07.11.2026 00:30');
  });
  it('computes business day range', () => {
    const { from, to } = tashkentDayRange('2026-11-06');
    expect(from.toISOString()).toBe('2026-11-05T19:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-06T19:00:00.000Z');
    expect(tashkentDateString(new Date('2026-11-06T19:00:00Z'))).toBe('2026-11-07');
  });
});

describe('permissions', () => {
  it('never lets a cashier be granted admin-only rights or price editing', () => {
    for (const p of ADMIN_ONLY_PERMISSIONS) {
      expect(ROLE_GRANTABLE_PERMISSIONS.cashier).not.toContain(p);
      expect(ROLE_GRANTABLE_PERMISSIONS.branch_manager).not.toContain(p);
    }
    expect((PERMISSIONS as readonly string[]).some((p) => p.startsWith('prices.edit'))).toBe(false);
  });
});

describe('createShopSchema', () => {
  const base = {
    name: 'Test shop',
    adminFullName: 'Ali Valiyev',
    adminPhone: '+998 90 123 45 67',
    adminLogin: 'ali.valiyev',
    adminPassword: 'password123',
  };
  it('applies defaults', () => {
    const r = createShopSchema.parse(base);
    expect(r.currency).toBe('UZS');
    expect(r.fiscalEnabled).toBe(false);
    expect(r.firstBranchName).toBe('Main branch');
    expect(r.adminPhone).toBe('+998901234567');
  });
  it('requires TIN when fiscal is on', () => {
    expect(createShopSchema.safeParse({ ...base, fiscalEnabled: true }).success).toBe(false);
    expect(createShopSchema.safeParse({ ...base, fiscalEnabled: true, tin: '123456789' }).success).toBe(true);
  });
  it('rejects bad logins', () => {
    expect(createShopSchema.safeParse({ ...base, adminLogin: 'a b' }).success).toBe(false);
  });
});

import { barcodeModules, buildInternalBarcode, CODE128_PATTERNS, code128bModules, ean13CheckDigit, ean13Modules, isValidEan13, isValidEan8 } from './barcode';

describe('barcodes', () => {
  it('validates EAN-13 / EAN-8 check digits', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan8('96385074')).toBe(true);
    expect(ean13CheckDigit('400638133393')).toBe(1);
  });
  it('builds internal EAN-13 barcodes: 2 + shop code + sequence + check digit', () => {
    const code = buildInternalBarcode(12, 345);
    expect(code).toHaveLength(13);
    expect(code.startsWith('200120000345')).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });
  it('renders EAN-13 as 95 modules with guard bars', () => {
    const m = ean13Modules('4006381333931');
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toEqual([1, 0, 1]);
    expect(m.slice(45, 50)).toEqual([0, 1, 0, 1, 0]);
    expect(m.slice(92)).toEqual([1, 0, 1]);
  });
  it('Code128 patterns are well-formed (each symbol = 11 modules, 6 bars)', () => {
    expect(CODE128_PATTERNS).toHaveLength(106);
    for (const p of CODE128_PATTERNS) {
      expect(p).toHaveLength(6);
      expect(p.split('').reduce((s, d) => s + Number(d), 0)).toBe(11);
    }
    // start + n chars + checksum = 11 modules each, stop = 13
    expect(code128bModules('ABC123')).toHaveLength(11 * (1 + 6 + 1) + 13);
    expect(barcodeModules('ABC-1').symbology).toBe('CODE128');
    expect(barcodeModules('4006381333931').symbology).toBe('EAN13');
  });
});
