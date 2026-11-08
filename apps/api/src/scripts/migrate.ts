import mongoose, { Schema } from 'mongoose';
import { connectDb, disconnectDb } from '../db/connect';
import { logger } from '../lib/logger';

/**
 * Versioned migrations for data and indexes (spec 14.6). Each migration runs once, in order,
 * and is recorded in the `migrations` collection. Add new migrations at the END of the list.
 */
interface Migration {
  id: string;
  run: () => Promise<void>;
}

export const migrations: Migration[] = [
  {
    id: '0001-sync-indexes',
    async run() {
      for (const model of Object.values(mongoose.models)) await model.syncIndexes();
    },
  },
];

const Applied = mongoose.model(
  'Migration',
  new Schema({ id: { type: String, unique: true }, appliedAt: { type: Date, default: Date.now } }),
);

export async function runMigrations(): Promise<string[]> {
  // Make sure every model is registered before indexes are synced.
  await import('../models');
  const done: string[] = [];
  for (const m of migrations) {
    if (await Applied.exists({ id: m.id })) continue;
    logger.info('migration start', { id: m.id });
    await m.run();
    await Applied.create({ id: m.id });
    done.push(m.id);
  }
  return done;
}

if (require.main === module && /migrate\.(ts|js)$/.test(process.argv[1] ?? '')) {
  (async () => {
    await connectDb();
    const done = await runMigrations();
    console.log(done.length ? `Applied: ${done.join(', ')}` : 'Nothing to migrate.');
    await disconnectDb();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
