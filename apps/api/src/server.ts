import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { connectDb, disconnectDb } from './db/connect';
import { logger } from './lib/logger';
import { agentHub } from './modules/agent/hub';
import { startSubscribers } from './subscribers';
import { startWorkers, stopWorkers } from './workers';
import { runMigrations } from './scripts/migrate';
import { seedSuperadmin } from './scripts/seed-superadmin';

async function main() {
  await connectDb();
  // Hosts such as Render (free plan) have no console for one-off commands: set up on every start.
  const applied = await runMigrations();
  if (applied.length) logger.info('migrations applied', { applied });
  if (env.SUPERADMIN_LOGIN && env.SUPERADMIN_PASSWORD) {
    const r = await seedSuperadmin();
    if (r.created) logger.info('superadmin created', { login: env.SUPERADMIN_LOGIN });
  }
  const app = createApp();
  const server = http.createServer(app);

  startSubscribers();
  agentHub.attach(server);
  if (env.RUN_WORKERS) startWorkers();

  server.listen(env.PORT, () => logger.info('api listening', { port: env.PORT }));

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    stopWorkers();
    agentHub.close();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('fatal', { err: String(err?.stack ?? err) });
  process.exit(1);
});
