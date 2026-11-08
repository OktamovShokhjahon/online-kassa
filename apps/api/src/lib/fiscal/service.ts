import { AppError, unprocessable } from '../errors';
import { decrypt } from '../crypto';
import { logger } from '../logger';
import { FiscalLog } from '../../models/sales';
import type { ShopDoc, TerminalDoc } from '../../models/core';
import { HttpJsonFiscalProvider } from './httpJson';
import { MockFiscalProvider } from './mock';
import type { FiscalContext, FiscalProvider } from './provider';

const providers = new Map<string, FiscalProvider>();
export function registerFiscalProvider(p: FiscalProvider) {
  providers.set(p.name, p);
}
registerFiscalProvider(new MockFiscalProvider());
registerFiscalProvider(new HttpJsonFiscalProvider());
export const fiscalProviderNames = () => [...providers.keys()];

export const FISCAL_TIMEOUT_MS = () => Number(process.env.FISCAL_TIMEOUT_MS ?? 10_000);

export function getProvider(terminal: Pick<TerminalDoc, 'fiscal'>): FiscalProvider {
  const name = terminal.fiscal?.provider;
  const provider = name ? providers.get(name) : undefined;
  if (!provider) throw unprocessable('FISCAL_NOT_CONFIGURED');
  return provider;
}

export function fiscalContext(terminal: TerminalDoc, shop: Pick<ShopDoc, 'tin'>): FiscalContext {
  let credentials: Record<string, any> = {};
  if (terminal.fiscal?.credentialsEncrypted) {
    try {
      credentials = JSON.parse(decrypt(terminal.fiscal.credentialsEncrypted));
    } catch {
      throw unprocessable('FISCAL_NOT_CONFIGURED');
    }
  }
  return { terminalId: String(terminal._id), moduleId: terminal.fiscal?.moduleId, tin: shop.tin, credentials, timeoutMs: FISCAL_TIMEOUT_MS() };
}

const SECRET = /key|secret|token|password|credential/i;
const scrubDeep = (v: any, depth = 0): any => {
  if (depth > 5 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, SECRET.test(k) ? '[REDACTED]' : scrubDeep(val, depth + 1)]));
};

/**
 * Runs one fiscal operation with a hard timeout (default 10 s) and writes a log entry (spec 8.6).
 * On timeout or error the caller's business operation must NOT complete: this throws FISCAL_ERROR
 * (502) so the POS can show the error and offer a retry. Secrets are never logged.
 */
export async function runFiscal<T>(opts: {
  terminal: TerminalDoc;
  shop: Pick<ShopDoc, '_id' | 'tin'>;
  docType: 'sale' | 'refund' | 'open_shift' | 'close_shift' | 'status';
  docId?: unknown;
  request?: unknown;
  fn: (provider: FiscalProvider, ctx: FiscalContext) => Promise<T>;
}): Promise<T> {
  const provider = getProvider(opts.terminal);
  const ctx = fiscalContext(opts.terminal, opts.shop);
  const started = Date.now();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('fiscal timeout'), { timeout: true })), ctx.timeoutMs);
  });
  const log = (status: 'ok' | 'error' | 'timeout', response?: unknown, error?: string) =>
    FiscalLog.create({
      shopId: opts.shop._id,
      terminalId: opts.terminal._id,
      docType: opts.docType,
      docId: opts.docId as any,
      provider: provider.name,
      request: scrubDeep(opts.request),
      response: scrubDeep(response),
      status,
      error,
      durationMs: Date.now() - started,
    }).catch((e) => logger.error('fiscal log failed', { err: String(e) }));

  try {
    const result = await Promise.race([opts.fn(provider, ctx), timeout]);
    await log('ok', result);
    return result;
  } catch (err: any) {
    const isTimeout = !!err?.timeout || err?.name === 'AbortError';
    await log(isTimeout ? 'timeout' : 'error', undefined, String(err?.message ?? err));
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'FISCAL_ERROR', undefined, { reason: isTimeout ? 'timeout' : 'provider_error' });
  } finally {
    clearTimeout(timer!);
  }
}
