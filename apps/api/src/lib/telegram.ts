import { env } from '../config/env';
import { sha256 } from './crypto';
import { logger } from './logger';

/**
 * Telegram Bot API transport. Tests (and dry runs without a bot token) swap it with
 * `setTelegramTransport`; with no token configured messages are only logged.
 */
export type TelegramTransport = (chatId: string, text: string) => Promise<void>;

let transport: TelegramTransport = async (chatId, text) => {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.debug('telegram (no bot token) would send', { chatId, text });
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
};

export function setTelegramTransport(t: TelegramTransport) {
  transport = t;
}

export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  try {
    await transport(chatId, text);
    return true;
  } catch (err) {
    logger.warn('telegram send failed', { chatId, err: String(err) });
    return false;
  }
}

/** Secret path segment of the bot webhook URL (https://api/v1/telegram/webhook/<secret>). */
export function telegramWebhookSecret(): string {
  return process.env.TELEGRAM_WEBHOOK_SECRET || (env.TELEGRAM_BOT_TOKEN ? sha256(env.TELEGRAM_BOT_TOKEN).slice(0, 24) : 'dev-webhook-secret');
}
