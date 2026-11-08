import { TZ_OFFSET_HOURS } from './constants';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Asia/Tashkent is UTC+5 all year with no daylight saving, so a fixed offset is exact. */
export function toTashkent(date: Date): Date {
  return new Date(date.getTime() + TZ_OFFSET_HOURS * HOUR);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** `YYYY-MM-DD` of the Tashkent calendar day containing the instant. */
export function tashkentDateString(date: Date): string {
  const t = toTashkent(date);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** `DD.MM.YYYY HH:mm` in Tashkent time. */
export function formatTashkent(date: Date | string | number, withSeconds = false): string {
  const t = toTashkent(new Date(date));
  const base = `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()} ${pad(
    t.getUTCHours(),
  )}:${pad(t.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(t.getUTCSeconds())}` : base;
}

/** UTC instant at which the Tashkent day `YYYY-MM-DD` starts (00:00 Tashkent). */
export function tashkentDayStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - TZ_OFFSET_HOURS * HOUR);
}

/** [start, end) UTC range of a Tashkent business day (00:00-23:59:59.999). */
export function tashkentDayRange(dateStr: string): { from: Date; to: Date } {
  const from = tashkentDayStart(dateStr);
  return { from, to: new Date(from.getTime() + DAY) };
}

/** UTC range covering Tashkent days `fromStr` to `toStr` inclusive. */
export function tashkentPeriod(fromStr: string, toStr: string): { from: Date; to: Date } {
  return { from: tashkentDayStart(fromStr), to: new Date(tashkentDayStart(toStr).getTime() + DAY) };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}
