import { logger } from '../lib/logger';
import { debtReminderJob, dailySummaryJob, expiryNoticeJob, longShiftJob } from '../modules/telegram/notifier';
import { deliverDue, reclaimStuckDeliveries } from '../modules/developers/webhooks';
import { precomputeYesterday } from '../modules/reports/daily';
import { applyScheduledPrices } from './scheduledPrices';
import { expireShops } from './shopExpiry';

/**
 * Background jobs. Each job is idempotent so several API instances can run them safely.
 * (Production may move these into the dedicated worker container: `npm run start:worker`.)
 */
interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const jobs: Job[] = [
  { name: 'shop-expiry', everyMs: 5 * 60_000, run: expireShops },
  { name: 'scheduled-prices', everyMs: 30_000, run: applyScheduledPrices },
  { name: 'webhook-delivery', everyMs: 5_000, run: () => deliverDue(50) },
  { name: 'webhook-reclaim', everyMs: 60_000, run: reclaimStuckDeliveries },
  { name: 'telegram-daily-summary', everyMs: 60_000, run: () => dailySummaryJob() },
  { name: 'telegram-long-shift', everyMs: 10 * 60_000, run: () => longShiftJob() },
  { name: 'telegram-debts', everyMs: 30 * 60_000, run: () => debtReminderJob() },
  { name: 'telegram-expiry', everyMs: 60 * 60_000, run: () => expiryNoticeJob() },
  { name: 'daily-summaries', everyMs: 6 * 3600_000, run: precomputeYesterday },
];
const timers: NodeJS.Timeout[] = [];

export function registerJob(job: Job) {
  jobs.push(job);
}

export function startWorkers() {
  for (const job of jobs) {
    const tick = async () => {
      try {
        await job.run();
      } catch (err) {
        logger.error('job failed', { job: job.name, err: String(err) });
      }
    };
    timers.push(setInterval(tick, job.everyMs).unref());
    void tick();
  }
  logger.info('workers started', { jobs: jobs.map((j) => j.name) });
}

export function stopWorkers() {
  timers.forEach(clearInterval);
  timers.length = 0;
}
