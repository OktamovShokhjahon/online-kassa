import { connectDb } from './db/connect';
import { logger } from './lib/logger';
import { startWorkers } from './workers';

/** Dedicated worker process (deployment: separate container with RUN_WORKERS=false on the API). */
connectDb()
  .then(() => startWorkers())
  .catch((err) => {
    logger.error('worker fatal', { err: String(err?.stack ?? err) });
    process.exit(1);
  });
