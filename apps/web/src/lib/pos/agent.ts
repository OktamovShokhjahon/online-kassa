import { api, post } from '@/lib/api';

export interface DeviceStatus { printer: 'ok' | 'error' | 'not_configured'; printerError?: string; scanner: 'ok' | 'none'; drawer: 'enabled' | 'disabled' }
export type AgentState = 'offline' | 'connecting' | 'ready';

interface Pending { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }
export class AgentError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const KEY_STORE = (terminalId: string) => `kass.agentKey.${terminalId}`;

/**
 * Local socket to the agent (ws://127.0.0.1:17890, spec 9.4). The session key is obtained from the
 * server for this terminal, cached, and verified by the agent locally, so printing keeps working
 * without internet until the key expires (12 h) - the POS refreshes it while online.
 */
export class AgentClient {
  state: AgentState = 'offline';
  devices: DeviceStatus | null = null;
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private backoff = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private terminalId: string,
    private cb: { onState: (s: AgentState, d: DeviceStatus | null) => void; onScan: (code: string) => void },
    private port = 17890,
  ) {}

  start() {
    this.stopped = false;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.set('offline');
  }

  private set(s: AgentState, d: DeviceStatus | null = this.devices) {
    this.state = s;
    this.devices = d;
    this.cb.onState(s, d);
  }

  /** Cached key while valid; a fresh one from the server whenever it is close to expiry and we are online. */
  async sessionKey(): Promise<string | null> {
    let cached: { key: string; exp: number } | null = null;
    try { cached = JSON.parse(localStorage.getItem(KEY_STORE(this.terminalId)) ?? 'null'); } catch { /* ignore */ }
    const fresh = cached && cached.exp - Date.now() > 3600_000;
    if (fresh) return cached!.key;
    try {
      const r = await post('/pos/agent-session', { terminalId: this.terminalId });
      const exp = new Date(r.expiresAt).getTime();
      try { localStorage.setItem(KEY_STORE(this.terminalId), JSON.stringify({ key: r.sessionKey, exp })); } catch { /* ignore */ }
      return r.sessionKey;
    } catch {
      return cached && cached.exp > Date.now() ? cached.key : null; // offline: use what we have while it is still valid
    }
  }

  private async connect() {
    if (this.stopped) return;
    this.set('connecting');
    const key = await this.sessionKey();
    if (!key) { this.backoff = Math.max(this.backoff, 30_000); return this.retry(); } // not paired / no session: do not hammer the server
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${this.port}`); } catch { return this.retry(); }
    this.ws = ws;
    ws.onopen = async () => {
      try {
        await this.request('hello', { sessionKey: key, terminalId: this.terminalId }, 5000);
        this.backoff = 1000;
        this.set('ready');
      } catch {
        try { localStorage.removeItem(KEY_STORE(this.terminalId)); } catch { /* ignore */ }
        ws.close();
      }
    };
    ws.onmessage = (ev) => {
      let m: { type: string; id: string; payload: any };
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'ack' || m.type === 'error') {
        const p = this.pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.type === 'ack' ? p.resolve(m.payload) : p.reject(new AgentError(m.payload?.code ?? 'ERROR', m.payload?.message ?? 'Agent error'));
      } else if (m.type === 'status') this.set(this.state, m.payload);
      else if (m.type === 'scan') this.cb.onScan(String(m.payload?.barcode ?? ''));
    };
    ws.onclose = () => {
      this.ws = null;
      this.pending.forEach((p) => { clearTimeout(p.timer); p.reject(new AgentError('AGENT_OFFLINE', 'Agent disconnected')); });
      this.pending.clear();
      this.set('offline', null);
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (this.stopped) return;
    this.set('offline', null);
    this.timer = setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(15_000, this.backoff * 2);
  }

  request(type: string, payload: unknown, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new AgentError('AGENT_OFFLINE', 'The local agent is not connected'));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError('TIMEOUT', 'The agent did not answer')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type, id, payload }));
    });
  }

  /**
   * Prints through the local socket; when it is down but the internet works, the job is routed
   * through the server to the agent's outgoing link (spec 9.4).
   */
  async print(type: 'print.receipt' | 'print.label' | 'print.report' | 'print.test' | 'drawer.open', payload: unknown): Promise<void> {
    if (this.state === 'ready') {
      await this.request(type, payload);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      await api('/pos/print', { method: 'POST', json: { terminalId: this.terminalId, type, payload } });
      return;
    }
    throw new AgentError('AGENT_OFFLINE', 'No connection to the printer agent');
  }
}
