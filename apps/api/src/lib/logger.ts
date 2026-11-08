import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = env.isTest ? 100 : env.isProd ? order.info : order.debug;

const SECRET_KEYS = /pass|pin|token|secret|authorization|cookie|key|credential/i;

/** Structured JSON logger. Secrets are redacted by key name. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(data) as object) });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
export { redact };
