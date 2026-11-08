import type { ConfigStore } from './config';
import { machineId } from './secretStore';

export class PairingError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Exchanges the 6-digit code from the panel for a device token bound to one terminal (spec 9.3). */
export async function pair(config: ConfigStore, serverUrl: string, code: string, version: string) {
  const base = serverUrl.replace(/\/$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), machineId: machineId(), version }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e: any) {
    throw new PairingError('NETWORK', `Cannot reach the server: ${e?.message ?? e}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PairingError(body?.error?.code ?? 'PAIRING_FAILED', body?.error?.message ?? `HTTP ${res.status}`);
  const d = body.data;
  config.update({
    serverUrl: base,
    wsUrl: d.wsUrl,
    terminal: d.terminal,
    allowedOrigins: d.webOrigins?.length ? d.webOrigins : config.get().allowedOrigins,
    language: d.shop?.receiptLanguage ?? config.get().language,
    printer: { ...config.get().printer, ...(d.terminal?.printerProfile ?? {}) },
  });
  config.setCredentials(d.token, d.sessionSecret);
  return d.terminal as { id: string; name: string; branchId: string };
}

/** Pulls the printer profile the shop admin edited in the panel. */
export async function refreshConfig(config: ConfigStore) {
  const token = config.token();
  if (!token) return;
  const res = await fetch(`${config.get().serverUrl}/api/v1/agent/config`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return;
  const d = (await res.json() as any).data;
  config.update({ terminal: { id: d.terminal.id, name: d.terminal.name, branchId: d.terminal.branchId }, printer: { ...config.get().printer, ...(d.terminal.printerProfile ?? {}) } });
}

export const compareVersions = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
};

/** Checked at start and every 6 hours; the settings window shows the download link. */
export async function checkForUpdate(config: ConfigStore, current: string): Promise<{ available: boolean; version?: string; url?: string }> {
  const token = config.token();
  if (!token) return { available: false };
  try {
    const res = await fetch(`${config.get().serverUrl}/api/v1/agent/latest-version`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const d = (await res.json() as any).data;
    return { available: !!d?.url && compareVersions(d.version, current) > 0, version: d?.version, url: d?.url };
  } catch {
    return { available: false };
  }
}
