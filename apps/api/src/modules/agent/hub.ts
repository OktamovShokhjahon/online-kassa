import crypto from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/crypto';
import { effectiveStatus, getGraceDays } from '../../lib/platform';
import { logger } from '../../lib/logger';
import { Shop, Terminal } from '../../models/core';

export const AGENT_WS_PATH = '/api/v1/agent/ws';

interface Conn {
  ws: WebSocket;
  shopId: string;
  alive: boolean;
}
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Server side of the agent link (spec 9.4): the agent opens an OUTGOING WebSocket with its
 * device token, heartbeats every 30 s, and answers commands (remote test print, print jobs
 * routed through the server). No inbound ports are needed on the cash desk PC.
 *
 * Connections are held in memory per API instance. With several instances behind Nginx, route
 * `/agent/ws` with sticky sessions or add a Redis pub/sub relay (see docs/DEPLOYMENT.md).
 */
class AgentHub {
  private conns = new Map<string, Conn>();
  private pending = new Map<string, Pending>();
  private wss = new WebSocketServer({ noServer: true });
  private pinger?: NodeJS.Timeout;

  attach(server: http.Server) {
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith(AGENT_WS_PATH)) return;
      void this.handleUpgrade(req, socket as Duplex, head);
    });
    this.pinger = setInterval(() => this.sweep(), 30_000);
    this.pinger.unref();
  }

  close() {
    if (this.pinger) clearInterval(this.pinger);
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
  }

  private reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const url = new URL(req.url!, 'http://x');
      const token = url.searchParams.get('token') ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const terminal = token ? await this.terminalByToken(token) : null;
      if (!terminal) return this.reject(socket, 401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, String(terminal._id), String(terminal.shopId)));
    } catch (err) {
      logger.error('agent upgrade failed', { err: String(err) });
      this.reject(socket, 500, 'Error');
    }
  }

  /** Token -> terminal, refusing agents of blocked or expired shops. */
  async terminalByToken(token: string) {
    const terminal = await Terminal.findOne({ agentTokenHash: sha256(token), isActive: true }).setOptions({ crossTenant: true });
    if (!terminal) return null;
    const shop = await Shop.findById(terminal.shopId);
    if (!shop) return null;
    const st = effectiveStatus(shop, await getGraceDays());
    if (st.status === 'blocked' || st.status === 'expired') return null;
    return terminal;
  }

  private onConnection(ws: WebSocket, terminalId: string, shopId: string) {
    this.conns.get(terminalId)?.ws.close(4000, 'replaced'); // one agent per terminal
    const conn: Conn = { ws, shopId, alive: true };
    this.conns.set(terminalId, conn);
    void Terminal.updateOne({ _id: terminalId, shopId }, { $set: { lastSeenAt: new Date() } });
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data) => void this.onMessage(terminalId, shopId, conn, data.toString()));
    ws.on('close', () => {
      if (this.conns.get(terminalId) === conn) this.conns.delete(terminalId);
    });
    ws.on('error', () => ws.terminate());
    ws.send(JSON.stringify({ type: 'hello', id: crypto.randomUUID(), payload: { serverTime: new Date().toISOString(), heartbeatSeconds: 30 } }));
  }

  private async onMessage(terminalId: string, shopId: string, conn: Conn, raw: string) {
    let msg: { type?: string; id?: string; payload?: any };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg.type || !msg.id) return;
    if (msg.type === 'ack' || msg.type === 'error') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.type === 'ack') p.resolve(msg.payload ?? {});
      else p.reject(new AppError(502, 'PRINT_FAILED', undefined, msg.payload));
      return;
    }
    if (msg.type === 'heartbeat') {
      // re-validate on every heartbeat: revoked tokens and blocked shops are cut off within 30 s
      const t = await Terminal.findOne({ _id: terminalId, shopId, agentTokenHash: { $exists: true } });
      const shop = t ? await Shop.findById(shopId) : null;
      const status = shop ? effectiveStatus(shop, await getGraceDays()).status : 'blocked';
      if (!t || status === 'blocked' || status === 'expired') return conn.ws.close(4001, 'revoked');
      await Terminal.updateOne(
        { _id: terminalId, shopId },
        { $set: { lastSeenAt: new Date(), agentVersion: msg.payload?.version, deviceStatus: msg.payload?.devices } },
      );
      conn.ws.send(JSON.stringify({ type: 'ack', id: msg.id, payload: { serverTime: new Date().toISOString() } }));
    }
  }

  private sweep() {
    for (const [id, c] of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        this.conns.delete(id);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  isOnline(terminalId: string) {
    return this.conns.get(terminalId)?.ws.readyState === WebSocket.OPEN;
  }

  /** Sends a command to the agent and waits for its ack/error with the same id. */
  request(terminalId: string, type: string, payload: unknown, timeoutMs = 10_000): Promise<unknown> {
    const conn = this.conns.get(terminalId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return Promise.reject(new AppError(503, 'AGENT_OFFLINE'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(504, 'PRINT_FAILED', undefined, { reason: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type, id, payload }));
    });
  }

  /** Disconnect agents (revoked token, blocked shop). */
  disconnectTerminal(terminalId: string) {
    this.conns.get(terminalId)?.ws.close(4001, 'revoked');
  }
  disconnectShop(shopId: string) {
    for (const [id, c] of this.conns) if (c.shopId === shopId) this.disconnectTerminal(id);
  }
  onlineCount() {
    return this.conns.size;
  }
}

export const agentHub = new AgentHub();
