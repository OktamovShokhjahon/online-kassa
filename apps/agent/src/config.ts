import fs from 'node:fs';
import path from 'node:path';
import type { PrinterProfile } from './escpos';
import type { SecretStore } from './secretStore';

export type TransportKind = 'windows' | 'network' | 'serial' | 'file';

export interface AgentConfig {
  language: 'uz' | 'ru' | 'en';
  serverUrl: string;
  wsUrl: string;
  /** Web origins allowed to talk to the local socket (the platform's configured domain). */
  allowedOrigins: string[];
  localPort: number;
  uiPort: number;
  terminal?: { id: string; name: string; branchId: string };
  tokenEnc?: string;
  secretEnc?: string;
  printer: PrinterProfile & { transport: TransportKind; windowsName?: string; serialPath?: string; filePath?: string };
  scanner?: { serialPath?: string; baudRate?: number };
}

export const DEFAULT_CONFIG: AgentConfig = {
  language: 'uz',
  serverUrl: 'http://localhost:4000',
  wsUrl: '',
  allowedOrigins: ['http://localhost:3000'],
  localPort: 17890,
  uiPort: 17891,
  printer: { transport: 'windows', paperWidthMm: 58, printWidthDots: 384, charsPerLine: 32, codePage: 'CP866', cutEnabled: false, drawerEnabled: false },
};

/** Config file on disk; secrets (token, session secret) are kept encrypted. */
export class ConfigStore {
  private cfg: AgentConfig;
  private file: string;
  constructor(readonly dir: string, readonly secrets: SecretStore) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'config.json');
    this.cfg = this.load();
  }
  private load(): AgentConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw, printer: { ...DEFAULT_CONFIG.printer, ...(raw.printer ?? {}) } };
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }
  get(): AgentConfig { return this.cfg; }
  update(patch: Partial<AgentConfig>) {
    this.cfg = { ...this.cfg, ...patch, printer: { ...this.cfg.printer, ...(patch.printer ?? {}) } };
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }
  setCredentials(token: string, sessionSecret: string) { this.update({ tokenEnc: this.secrets.encrypt(token), secretEnc: this.secrets.encrypt(sessionSecret) }); }
  clearCredentials() { this.update({ tokenEnc: undefined, secretEnc: undefined, terminal: undefined }); }
  token(): string | null { return this.cfg.tokenEnc ? this.secrets.decrypt(this.cfg.tokenEnc) : null; }
  sessionSecret(): string | null { return this.cfg.secretEnc ? this.secrets.decrypt(this.cfg.secretEnc) : null; }
  isPaired() { return !!this.cfg.tokenEnc && !!this.cfg.terminal; }
}
