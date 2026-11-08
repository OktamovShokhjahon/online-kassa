import type { Currency, Language } from './constants';

/**
 * Money is stored as an integer count of minor units (tiyin, cents, kopeks).
 * All three currencies use 100 minor units per major unit.
 */
export const MINOR_PER_MAJOR = 100;

export function toMinor(major: number): number {
  return Math.round(major * MINOR_PER_MAJOR);
}

export function toMajor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

const SUFFIX: Record<Currency, Record<Language, string>> = {
  UZS: { uz: "so'm", ru: 'сум', en: 'UZS' },
  USD: { uz: '$', ru: '$', en: '$' },
  RUB: { uz: '₽', ru: '₽', en: '₽' },
};

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** `125 000 so'm` for UZS (no decimals); USD and RUB with 2 decimals. */
export function formatMoney(minor: number, currency: Currency, lang: Language = 'uz'): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const decimals = currency === 'UZS' ? 0 : 2;
  let major = abs / MINOR_PER_MAJOR;
  if (decimals === 0) major = Math.round(major);
  const fixed = major.toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const body = groupThousands(intPart) + (frac ? `.${frac}` : '');
  const sign = negative ? '-' : '';
  const suffix = SUFFIX[currency][lang];
  return currency === 'UZS' ? `${sign}${body} ${suffix}` : `${sign}${suffix}${body}`;
}

/** Percentage of an integer amount, rounded half-up to an integer of minor units. */
export function percentOf(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}

/** Line total = round(qty * price). Quantities may have 3 decimals. */
export function lineTotal(qty: number, unitPrice: number): number {
  return Math.round(qty * unitPrice);
}

/** Round a quantity to 3 decimals (weight goods) to avoid float drift. */
export function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}
