import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export async function connectDb(uri = env.MONGO_URI): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, ...(hasDbName(uri) ? {} : { dbName: env.MONGO_DB_NAME }) });
  logger.info('mongo connected');
  return mongoose;
}

/** `mongodb+srv://u:p@host/` has no database name; `.../onlinekass?...` has one. */
export function hasDbName(uri: string): boolean {
  const afterHost = uri.replace(/^mongodb(\+srv)?:\/\/[^/]*/, '');
  return /^\/[^/?]+/.test(afterHost);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/**
 * Runs `fn` inside a MongoDB transaction (replica set required). Every posted document
 * (sale, goods receipt, transfer...) goes through this so stock and money never diverge.
 */
export async function withTx<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
