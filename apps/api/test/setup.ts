import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { connectDb, disconnectDb } from '../src/db/connect';
import '../src/models';
import { invalidatePlatformCache } from '../src/lib/platform';

beforeAll(async () => {
  await connectDb(process.env.TEST_MONGO_URI);
  // Unique indexes matter for the behaviour under test.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

beforeEach(async () => {
  invalidatePlatformCache();
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await disconnectDb();
});
