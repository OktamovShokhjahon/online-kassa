import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ConfigStore } from './config';
import { AgentError, type Handlers } from './handlers';

/** Verifies `<expMs>.<base64url HMAC(secret, terminalId.expMs)>` issued by the server for this terminal. */
export function verifySessionKey(secret: string, terminalId: string, key: string, now = Date.now()): boolean {
  const [exp, mac] = String(key).split('.');
  const expMs = Number(exp);
  if (!mac || !Number.isFinite(expMs) || expMs < now) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${terminalId}.${expMs}`).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface Client {
  ws: WebSocket;
  authed: boolean;
}

/**
 * Local socket for the POS page (ws://127.0.0.1:17890). Only the platform's configured web origin may
 * connect, and each connection must start with a `hello` carrying a server-issued session key for
 * this terminal. Works without internet: the key is verified locally with the pairing secret.
 */
export class LocalServer {
  private server?: http.Server;
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Set<Client>();

  constructor(private config: ConfigStore, private handlers: Handlers, private opts: { host?: string; allowNoOrigin?: boolean } = {}) {}

  start(port = this.config.get().localPort): Promise<number> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Online Kass agent: WebSocket only');
    });
    this.server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin;
      const allowed = this.config.get().allowedOrigins;
      const originOk = origin ? allowed.includes(origin) : !!this.opts.allowNoOrigin;
      // Host must be the loopback address: blocks DNS-rebinding attempts from hostile pages.
      const host = String(req.headers.host ?? '').split(':')[0];
      if (!originOk || !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return void socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, this.opts.host ?? '127.0.0.1', () => resolve((this.server!.address() as any).port));
    });
  }

  stop() {
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.server?.close();
  }

  /** Pushes a message (scan, status) to every authenticated POS page. */
  broadcast(type: string, payload: unknown) {
    const msg = JSON.stringify({ type, id: crypto.randomUUID(), payload });
    for (const c of this.clients) if (c.authed && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg);
  }

  private onConnection(ws: WebSocket) {
    const client: Client = { ws, authed: false };
    this.clients.add(client);
    const timer = setTimeout(() => !client.authed && ws.close(4401, 'hello timeout'), 10_000);
    const reply = (type: 'ack' | 'error', id: string, payload: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type, id, payload }));

    ws.on('message', async (data) => {
      let msg: { type?: string; id?: string; payload?: any };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg.type || !msg.id) return;
      try {
        if (msg.type === 'hello') {
          const cfg = this.config.get();
          const secret = this.config.sessionSecret();
          const terminalId = cfg.terminal?.id;
          if (!secret || !terminalId) throw new AgentError('NOT_PAIRED', 'The agent is not paired with a terminal');
          if (msg.payload?.terminalId !== terminalId || !verifySessionKey(secret, terminalId, msg.payload?.sessionKey)) throw new AgentError('AUTH_FAILED', 'Invalid or expired session key');
          client.authed = true;
          clearTimeout(timer);
          reply('ack', msg.id, { agentVersion: this.handlers.version, terminal: cfg.terminal });
          ws.send(JSON.stringify({ type: 'status', id: crypto.randomUUID(), payload: this.handlers.status() }));
          return;
        }
        if (!client.authed) throw new AgentError('NOT_AUTHENTICATED', 'Send hello first');
        reply('ack', msg.id, await this.handlers.run(msg.type, msg.payload));
      } catch (e: any) {
        reply('error', msg.id, { code: e instanceof AgentError ? e.code : 'INTERNAL', message: String(e?.message ?? e) });
        if (msg.type === 'hello') ws.close(4403, 'auth failed');
      }
    });
    ws.on('close', () => { clearTimeout(timer); this.clients.delete(client); });
    ws.on('error', () => ws.terminate());
  }
}
