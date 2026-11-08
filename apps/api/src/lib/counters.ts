import type { ClientSession, Types } from 'mongoose';
import { Counter } from '../models/core';

/** Atomic per-shop sequence (document numbering). Safe under concurrency and inside transactions. */
export async function nextSeq(
  shopId: Types.ObjectId,
  key: string,
  session?: ClientSession | null,
): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { shopId, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session: session ?? undefined },
  );
  return doc!.seq;
}

/** `PREFIX-000123` style number. */
export async function nextNumber(
  shopId: Types.ObjectId,
  key: string,
  prefix: string,
  session?: ClientSession | null,
): Promise<string> {
  const seq = await nextSeq(shopId, key, session);
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}
