import { Router } from 'express';
import { z } from 'zod';
import { auditSystem } from '../../lib/audit';
import { encrypt, randomToken, sha256 } from '../../lib/crypto';
import { env } from '../../config/env';
import { tooMany, unauthorized, unprocessable } from '../../lib/errors';
import { h, ok } from '../../lib/http';
import * as limiter from '../../lib/rateLimit';
import { getPlatformSettings } from '../../lib/platform';
import { assertShopUsable } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Shop, Terminal } from '../../models/core';
import { agentHub, AGENT_WS_PATH } from './hub';

export const agentRouter = Router();

/** Agent device-token authentication (spec 3.2: third credential type). */
export const authenticateAgent = h(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const terminal = await Terminal.findOne({ agentTokenHash: sha256(header.slice(7)), isActive: true }).setOptions({ crossTenant: true });
  if (!terminal) throw unauthorized('AGENT_REVOKED');
  const shop = await Shop.findById(terminal.shopId);
  await assertShopUsable(shop);
  req.agent = { kind: 'agent', terminalId: terminal._id, shopId: terminal.shopId, branchId: terminal.branchId, shop: shop! };
  (req as any).terminal = terminal;
  next();
});

const wsUrl = () => env.PUBLIC_API_URL.replace(/^http/, 'ws') + AGENT_WS_PATH;

/**
 * Pairing (spec 9.3): the 6-digit code from the panel + the machine id are exchanged for a
 * long-lived device token bound to that shop and terminal. The code is single-use, valid for
 * 10 minutes, and attempts are rate limited per IP.
 */
agentRouter.post(
  '/pair',
  validate({ body: z.object({ code: z.string().regex(/^\d{6}$/), machineId: z.string().min(4).max(128), version: z.string().max(32).optional() }) }),
  h(async (req, res) => {
    const key = `pair:${req.ip}`;
    if ((await limiter.hit(key, 10 * 60_000)).count > 10) throw tooMany('TOO_MANY_ATTEMPTS');

    const terminal = await Terminal.findOne({ pairingCodeHash: sha256(req.body.code), pairingExpiresAt: { $gt: new Date() }, isActive: true }).setOptions({ crossTenant: true });
    if (!terminal) throw unprocessable('PAIRING_CODE_INVALID');
    const shop = await Shop.findById(terminal.shopId);
    await assertShopUsable(shop);

    const token = `kat_${randomToken(32)}`;
    const secret = randomToken(32);
    terminal.agentTokenHash = sha256(token);
    terminal.agentSecretEncrypted = encrypt(secret);
    terminal.agentMachineId = req.body.machineId;
    terminal.agentVersion = req.body.version;
    terminal.lastSeenAt = new Date();
    terminal.pairingCodeHash = undefined;
    terminal.pairingExpiresAt = undefined;
    await terminal.save();
    agentHub.disconnectTerminal(String(terminal._id)); // an older agent on this terminal is replaced
    await auditSystem({ action: 'terminal.agent_paired', shopId: terminal.shopId, entity: 'terminal', entityId: terminal._id, meta: { machineId: req.body.machineId }, ip: req.ip });

    ok(res, {
      token,
      /** Verifies the short-lived POS session keys locally, so printing works offline. */
      sessionSecret: secret,
      wsUrl: wsUrl(),
      heartbeatSeconds: 30,
      /** Origins the agent accepts on its local socket. */
      webOrigins: env.WEB_ORIGIN.split(",").map((o) => o.trim()),
      terminal: { id: String(terminal._id), name: terminal.name, branchId: String(terminal.branchId), printerProfile: terminal.printerProfile },
      shop: { id: String(shop!._id), name: shop!.name, currency: shop!.currency, receiptLanguage: shop!.settings?.receiptLanguage ?? 'uz' },
    });
  }),
);

agentRouter.get(
  '/config',
  authenticateAgent,
  h(async (req, res) => {
    const t = (req as any).terminal;
    const shop = req.agent!.shop;
    ok(res, {
      terminal: { id: String(t._id), name: t.name, branchId: String(t.branchId), printerProfile: t.printerProfile },
      shop: { name: shop.name, currency: shop.currency, receiptLanguage: shop.settings?.receiptLanguage ?? 'uz' },
      wsUrl: wsUrl(),
    });
  }),
);

/** Auto-update check (agent calls it on start and every 6 hours). */
agentRouter.get(
  '/latest-version',
  authenticateAgent,
  h(async (_req, res) => {
    const s = await getPlatformSettings();
    ok(res, { version: s.agentInstaller?.version ?? '1.0.0', url: s.agentInstaller?.url ?? '' });
  }),
);

