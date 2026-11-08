import fs from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from './config';
import { renderLabels, renderReceipt, renderReport, renderTestPage, type LabelData, type ReceiptData, type ReportData } from './render';
import { createTransport, type Transport } from './transports';
import { EscPos } from './escpos';

export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export type Handler = (payload: any) => Promise<Record<string, unknown>>;

export interface DeviceStatus {
  printer: 'ok' | 'error' | 'not_configured';
  printerError?: string;
  scanner: 'ok' | 'none';
  drawer: 'enabled' | 'disabled';
}

/**
 * Executes the protocol commands (spec 9.5). Used by both the local POS socket and the server link,
 * so a job behaves the same whichever path it arrived on. The POS sends structured data only;
 * raw printer bytes are produced here.
 */
export class Handlers {
  private lastError: string | undefined;
  /** Override for tests. */
  transportFactory: (cfg: ReturnType<ConfigStore['get']>['printer']) => Transport | null = createTransport;

  constructor(private config: ConfigStore, readonly version: string) {}

  status(scannerConnected = false): DeviceStatus {
    const p = this.config.get().printer;
    const configured = !!this.transportFactory(p);
    return {
      printer: !configured ? 'not_configured' : this.lastError ? 'error' : 'ok',
      printerError: this.lastError,
      scanner: scannerConnected ? 'ok' : 'none',
      drawer: p.drawerEnabled ? 'enabled' : 'disabled',
    };
  }

  private async output(build: (profile: ReturnType<ConfigStore['get']>['printer']) => EscPos, extra?: (p: EscPos) => void) {
    const cfg = this.config.get().printer;
    const t = this.transportFactory(cfg);
    if (!t) throw new AgentError('PRINTER_NOT_CONFIGURED', 'No printer is configured on this PC');
    const doc = build(cfg);
    extra?.(doc);
    try {
      await t.send(doc.toBuffer());
      this.writePreview(doc);
      this.lastError = undefined;
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      throw new AgentError('PRINT_ERROR', this.lastError);
    }
    return { printed: true, lines: doc.preview.length };
  }

  /** Development aid: KASS_AGENT_PREVIEW=<file> also appends every printout as readable text. */
  private writePreview(doc: EscPos) {
    const file = process.env.KASS_AGENT_PREVIEW;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const box = '='.repeat(doc.width);
      fs.appendFileSync(file, [box, new Date().toISOString(), ...doc.preview, '', ''].join('\n'));
    } catch { /* a preview must never break printing */ }
  }

  private need<T>(v: T | undefined, what: string): T {
    if (v === undefined || v === null) throw new AgentError('BAD_PAYLOAD', `${what} is required`);
    return v;
  }

  readonly commands: Record<string, Handler> = {
    'print.receipt': async (payload) => {
      const receipt: ReceiptData = this.need(payload?.receipt ?? payload, 'receipt');
      if (!receipt.lines || !receipt.labels) throw new AgentError('BAD_PAYLOAD', 'receipt data is incomplete');
      const copies = Math.min(5, Math.max(1, Number(payload?.copies ?? 1)));
      let res: Record<string, unknown> = {};
      for (let i = 0; i < copies; i++) res = await this.output((p) => renderReceipt({ ...receipt, copy: receipt.copy || i > 0 }, p));
      return { ...res, copies };
    },
    'print.report': async (payload) => {
      const report: ReportData = this.need(payload?.report ?? payload, 'report');
      return this.output((p) => renderReport(report, p));
    },
    'print.label': async (payload) => {
      const labels: LabelData[] = Array.isArray(payload?.labels) ? payload.labels : [payload];
      if (!labels.length || !labels[0].name) throw new AgentError('BAD_PAYLOAD', 'label data is incomplete');
      return this.output((p) => renderLabels(labels, p));
    },
    'print.test': async (payload) => this.output((p) => renderTestPage(p, { terminal: this.config.get().terminal?.name, version: this.version })),
    'drawer.open': async () => {
      if (!this.config.get().printer.drawerEnabled) throw new AgentError('DRAWER_DISABLED', 'The cash drawer is disabled in the printer profile');
      return this.output((p) => new EscPos(p).openDrawer() as EscPos).then((r) => ({ ...r, opened: true }));
    },
  };

  async run(type: string, payload: unknown) {
    const h = this.commands[type];
    if (!h) throw new AgentError('UNKNOWN_COMMAND', `Unknown command ${type}`);
    return h(payload);
  }
}
