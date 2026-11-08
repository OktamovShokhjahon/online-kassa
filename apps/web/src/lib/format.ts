'use client';

import { useLocale } from 'next-intl';
import { formatMoney, formatTashkent, tashkentDateString, type Currency, type Language } from '@kass/shared';
import { useAuth } from './auth';

/** Money formatting in the shop currency and the user's language: `125 000 so'm`. */
export function useMoney() {
  const { shop } = useAuth();
  const lang = useLocale() as Language;
  const currency = (shop?.currency ?? 'UZS') as Currency;
  return {
    currency,
    m: (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : formatMoney(minor, currency, lang)),
    /** Without the currency sign, for tables whose header already says the currency. */
    n: (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : formatMoney(minor, currency, lang).replace(/\s?(so'm|сум|UZS)$/, '').replace(/^[$₽]/, '')),
  };
}

export const fmtDateTime = (d: string | Date | null | undefined) => (d ? formatTashkent(d) : '');
export const fmtDate = (d: string | Date | null | undefined) => (d ? tashkentDateString(new Date(d)) : '');
export const today = () => tashkentDateString(new Date());
export const daysAgo = (n: number) => tashkentDateString(new Date(Date.now() - n * 86_400_000));
