import type { FiscalContext, FiscalDoc, FiscalProvider, FiscalResult, FiscalStatus } from './provider';

/**
 * Generic REST adapter for providers that expose a JSON API. It is the template for the first
 * real integration: the exact paths and field names depend on the provider's official API
 * documentation and test credentials, which are required before Stage 8 can be finished for a
 * real provider. Credentials: `{ "baseUrl": "https://...", "apiKey": "..." }`.
 */
export class HttpJsonFiscalProvider implements FiscalProvider {
  readonly name = 'http-json';
  readonly supportsOffline = false;

  private async call(ctx: FiscalContext, path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
    const { baseUrl, apiKey } = ctx.credentials;
    if (!baseUrl || !apiKey) throw new Error('baseUrl and apiKey are required');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ctx.timeoutMs);
    try {
      const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Terminal': ctx.moduleId ?? '' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`fiscal provider HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private toResult(r: any, ctx: FiscalContext): FiscalResult {
    if (!r?.fiscalSign || !r?.receiptId) throw new Error('malformed fiscal response');
    return { sign: String(r.fiscalSign), receiptId: String(r.receiptId), qr: String(r.qrCode ?? ''), moduleId: String(r.moduleId ?? ctx.moduleId ?? ''), raw: r };
  }

  async openShift(ctx: FiscalContext) {
    const r = await this.call(ctx, '/shifts/open', 'POST', { tin: ctx.tin });
    return { fiscalShiftId: String(r.shiftId) };
  }
  async registerSale(ctx: FiscalContext, doc: FiscalDoc) {
    return this.toResult(await this.call(ctx, '/receipts', 'POST', { type: 'sale', tin: ctx.tin, ...doc }), ctx);
  }
  async registerRefund(ctx: FiscalContext, doc: FiscalDoc) {
    return this.toResult(await this.call(ctx, '/receipts', 'POST', { type: 'refund', tin: ctx.tin, ...doc }), ctx);
  }
  async closeShift(ctx: FiscalContext, fiscalShiftId?: string | null) {
    const r = await this.call(ctx, '/shifts/close', 'POST', { shiftId: fiscalShiftId });
    return { report: r };
  }
  async getStatus(ctx: FiscalContext): Promise<FiscalStatus> {
    const r = await this.call(ctx, '/status', 'GET');
    return { online: !!r.online, shiftOpen: r.shiftOpen, message: r.message };
  }
}
