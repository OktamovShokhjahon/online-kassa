import { DEFAULT_LANGUAGE, LANGUAGES, type Language } from '../constants';
import { en } from './en';
import { ru } from './ru';
import { uz } from './uz';

export interface Messages {
  [key: string]: string | Messages;
}

export const messages: Record<Language, Messages> = { uz, ru, en: en as unknown as Messages };

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Resolve `a.b.c` in a nested messages tree. */
export function lookup(tree: Messages, key: string): string | undefined {
  let cur: string | Messages | undefined = tree;
  for (const part of key.split('.')) {
    if (cur === undefined || typeof cur === 'string') return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** Translate a key; falls back to English, then to the key itself. */
export function translate(
  lang: Language,
  key: string,
  params?: Record<string, string | number>,
): string {
  const text = lookup(messages[lang] ?? messages[DEFAULT_LANGUAGE], key) ?? lookup(messages.en, key);
  return text === undefined ? key : interpolate(text, params);
}

/** Flatten a tree to dot-keys; used by the CI parity test. */
export function flattenKeys(tree: Messages, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [prefix + k] : flattenKeys(v, `${prefix}${k}.`),
  );
}

/** Pick the best language from an Accept-Language header. */
export function parseAcceptLanguage(header: string | undefined | null): Language | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const code = part.trim().slice(0, 2).toLowerCase();
    if (isLanguage(code)) return code;
  }
  return null;
}

export { DEFAULT_LANGUAGE };
