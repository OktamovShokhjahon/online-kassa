import { RateLimit } from '../models/core';

/**
 * Fixed-window counters stored in MongoDB (TTL-cleaned) so limits are shared across API
 * instances without extra infrastructure. Returns the count including this hit.
 */
export async function hit(key: string, windowMs: number): Promise<{ count: number; resetAt: Date }> {
  const now = new Date();
  const doc = await RateLimit.findOneAndUpdate(
    { key },
    [
      { $set: { _expired: { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, now] } } },
      {
        $set: {
          count: { $cond: ['$_expired', 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] },
          expiresAt: { $cond: ['$_expired', new Date(now.getTime() + windowMs), '$expiresAt'] },
        },
      },
      { $unset: '_expired' },
    ],
    { upsert: true, new: true },
  );
  return { count: doc!.count, resetAt: doc!.expiresAt };
}

/** Current count without incrementing. */
export async function peek(key: string): Promise<number> {
  const doc = await RateLimit.findOne({ key, expiresAt: { $gt: new Date() } }).lean();
  return doc?.count ?? 0;
}

export async function reset(key: string): Promise<void> {
  await RateLimit.deleteOne({ key });
}
