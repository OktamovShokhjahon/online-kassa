import crypto from 'node:crypto';
import type { FiscalContext, FiscalDoc, FiscalProvider, FiscalResult, FiscalStatus } from './provider';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Simulated provider for development, demos and tests. Behaviour is controlled by the terminal's
 * credentials JSON: `{ "fail": true }`, `{ "failRefund": true }`, `{ "delayMs": 15000 }`,
 * `{ "supportsOffline": false }`. It issues realistic-looking fiscal signs and QR links.
 */
export class MockFiscalProvider implements FiscalProvider {
  readonly name = 'mock';
  readonly supportsOffline = true;
  static issued: Array<{ kind: 'sale' | 'refund'; number: string; receiptId: string }> = [];

  private async guard(ctx: FiscalContext, refund = false) {
    if (ctx.credentials.delayMs) await sleep(Number(ctx.credentials.delayMs));
    if (ctx.credentials.fail || (refund && ctx.credentials.failRefund)) throw new Error('mock fiscal module unavailable');
  }

  private result(kind: 'sale' | 'refund', ctx: FiscalContext, doc: FiscalDoc): FiscalResult {
    const receiptId = crypto.randomBytes(6).toString('hex').toUpperCase();
    const sign = String(crypto.createHash('sha256').update(`${receiptId}${doc.number}${doc.total}`).digest().readUIntBE(0, 6)).padStart(12, '0').slice(-12);
    MockFiscalProvider.issued.push({ kind, number: doc.number, receiptId });
    return {
      sign,
      receiptId,
      moduleId: ctx.moduleId ?? 'MOCK-0001',
      qr: `https://ofd.example.test/check?t=${ctx.moduleId ?? 'MOCK-0001'}&r=${receiptId}&s=${doc.total}&c=${doc.createdAt.toISOString()}`,
    };
  }

  async openShift(ctx: FiscalContext) {
    await this.guard(ctx);
    return { fiscalShiftId: `MOCK-SHIFT-${crypto.randomBytes(3).toString('hex')}` };
  }
  async registerSale(ctx: FiscalContext, doc: FiscalDoc) {
    await this.guard(ctx);
    return this.result('sale', ctx, doc);
  }
  async registerRefund(ctx: FiscalContext, doc: FiscalDoc) {
    await this.guard(ctx, true);
    if (!doc.refundOfReceiptId) throw new Error('refund must reference the original fiscal receipt');
    return this.result('refund', ctx, doc);
  }
  async closeShift(ctx: FiscalContext) {
    await this.guard(ctx);
    return { report: { closedAt: new Date().toISOString(), module: ctx.moduleId ?? 'MOCK-0001' } };
  }
  async getStatus(ctx: FiscalContext): Promise<FiscalStatus> {
    if (ctx.credentials.fail) return { online: false, message: 'mock module unavailable' };
    return { online: true, shiftOpen: true, message: 'mock module ok' };
  }
}
