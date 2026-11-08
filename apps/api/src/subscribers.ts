import { startWebhookDispatcher } from './modules/developers/webhooks';
import { startNotifier } from './modules/telegram/notifier';

let started = false;

/**
 * Wires the in-process domain event bus to its consumers: signed webhooks and Telegram
 * notifications. Runs in the API process (where events happen); background jobs that deliver and
 * retry live in the workers.
 */
export function startSubscribers() {
  if (started) return;
  started = true;
  startWebhookDispatcher();
  startNotifier();
}

export function resetSubscribers() {
  started = false;
}
