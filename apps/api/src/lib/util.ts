import type { Types } from 'mongoose';
import mongoose from 'mongoose';

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const oid = (id: string | Types.ObjectId) => new mongoose.Types.ObjectId(String(id));

export const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

/** Parses `-createdAt` / `name` into a Mongo sort object, whitelisting allowed fields. */
export function parseSort(sort: string | undefined, allowed: string[], fallback = '-createdAt') {
  const raw = sort && allowed.includes(sort.replace(/^-/, '')) ? sort : fallback;
  return { [raw.replace(/^-/, '')]: raw.startsWith('-') ? -1 : 1 } as Record<string, 1 | -1>;
}

export const pick = <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
};
