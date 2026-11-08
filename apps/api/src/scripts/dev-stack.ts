/**
 * One-command development backend: an in-memory MongoDB replica set (transactions work), the API on
 * port 4000, a superadmin and optionally a demo shop. No Docker or local MongoDB needed.
 *
 *   npm run dev:stack            -> API + empty database + superadmin (admin / a@a@admina@a@)
 *   npm run dev:stack -- --demo  -> additionally creates a demo shop with data
 *
 * Data lives in .devdata/ so it survives restarts (delete the folder to reset).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.NODE_ENV ??= 'development';
process.env.BCRYPT_COST ??= '8';
process.env.RUN_WORKERS ??= 'true';
process.env.ALLOW_PRIVATE_WEBHOOKS ??= 'true';

async function main() {
  const dbPath = path.resolve(process.cwd(), '../../.devdata/mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ dbPath, port: 27018 }] });
  process.env.MONGO_URI = rs.getUri('onlinekass');
  console.log('MongoDB (in memory replica set):', process.env.MONGO_URI);

  const { connectDb } = await import('../db/connect');
  const { createApp } = await import('../app');
  const { env } = await import('../config/env');
  const { startWorkers } = await import('../workers');
  const { agentHub } = await import('../modules/agent/hub');
  const { startSubscribers } = await import('../subscribers');
  const { runMigrations } = await import('./migrate');
  const { seedSuperadmin } = await import('./seed-superadmin');

  await connectDb();
  await runMigrations();
  const seeded = await seedSuperadmin(process.env.SUPERADMIN_LOGIN ?? 'admin', process.env.SUPERADMIN_PASSWORD ?? 'a@a@admina@a@');
  console.log(seeded.created ? 'Superadmin created: admin / a@a@admina@a@' : 'Superadmin exists: admin');

  const server = http.createServer(createApp());
  startSubscribers();
  agentHub.attach(server);
  startWorkers();
  await new Promise<void>((r) => server.listen(env.PORT, r));
  console.log(`API ready on http://localhost:${env.PORT}/api/v1`);

  if (process.argv.includes('--demo')) {
    const { seedDemo } = await import('./seed-demo');
    await seedDemo(`http://localhost:${env.PORT}/api/v1`);
  }
  const stop = async () => { agentHub.close(); server.close(); await rs.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
