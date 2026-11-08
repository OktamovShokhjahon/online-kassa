import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { ConfigStore } from './config';
import { AgentError, type Handlers } from './handlers';

/**
 * Outgoing WebSocket to the platform (spec 9.4): heartbeat every 30 s with version and device
 * status, plus commands from the server (remote test print, print jobs routed through the server).
 * No inbound ports are opened. Reconnects with backoff; a close with code 4001 means the token was
 * revoked (or the shop blocked), so the stored credentials are removed.
 */
export class ServerLink {
  private ws?: WebSocket;
  private timer?: NodeJS.Timeout;
  private hb?: NodeJS.Timeout;
  private backoff = 1000;
  private stopped = false;
  online = false;
  onRevoked?: () => void;

  constructor(private config: ConfigStore, private handlers: Handlers, private scannerConnected: () => boolean = () => false) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.hb);
    this.ws?.terminate();
  }

  private connect() {
    const token = this.config.token();
    const url = this.config.get().wsUrl;
    if (this.stopped || !token || !url) return;
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.on('open', () => {
      this.online = true;
      this.backoff = 1000;
      this.heartbeat();
      this.hb = setInterval(() => this.heartbeat(), 30_000);
    });
    ws.on('message', async (data) => {
      let msg: { type?: string; id?: string; payload?: any };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg.type || !msg.id || msg.type === 'hello' || msg.type === 'ack') return;
      if (!(msg.type in this.handlers.commands)) return;
      try {
        ws.send(JSON.stringify({ type: 'ack', id: msg.id, payload: await this.handlers.run(msg.type, msg.payload) }));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, payload: { code: e instanceof AgentError ? e.code : 'INTERNAL', message: String(e?.message ?? e) } }));
      }
    });
    ws.on('close', (code) => {
      this.online = false;
      clearInterval(this.hb);
      if (code === 4001) {
        this.config.clearCredentials();
        this.onRevoked?.();
        return;
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(60_000, this.backoff * 2);
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private heartbeat() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'heartbeat', id: crypto.randomUUID(), payload: { version: this.handlers.version, devices: this.handlers.status(this.scannerConnected()), uptime: Math.round(process.uptime()), host: os.hostname() } }));
  }
}
