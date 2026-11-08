import { Router } from 'express';
import { z } from 'zod';
import { objectId, terminalInputSchema, terminalUpdateSchema } from '@kass/shared';
import { audit } from '../../lib/audit';
import { randomDigits, sha256 } from '../../lib/crypto';
import { notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok, repo } from '../../lib/http';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch, Terminal } from '../../models/core';
import { agentHub } from '../agent/hub';

export const terminalsRouter = Router();
terminalsRouter.use(authenticate);

const idParams = validate({ params: z.object({ id: objectId }) });
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const AGENT_ONLINE_MS = 90_000;

function present(t: any) {
  const j = t.toJSON();
  return {
    ...j,
    paired: !!t.agentTokenHash,
    online: !!t.lastSeenAt && Date.now() - new Date(t.lastSeenAt).getTime() < AGENT_ONLINE_MS,
    pairingExpiresAt: undefined,
  };
}

terminalsRouter.get(
  '/',
  h(async (req, res) => {
    const a = auth(req);
    const filter: Record<string, unknown> = a.role === 'shop_admin' ? {} : { branchId: { $in: a.branchIds } };
    const items = await repo(req, Terminal).find(filter, { sort: 'name' });
    ok(res, items.map(present));
  }),
);

terminalsRouter.post(
  '/',
  requirePermission('terminals.manage'),
  validate({ body: terminalInputSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = repo(req, Terminal);
    if (!(await repo(req, Branch).exists({ _id: req.body.branchId }))) throw notFound('BRANCH_NOT_FOUND');
    if ((await r.count({ isActive: true })) >= a.shop!.limits!.maxTerminals) throw unprocessable('LIMIT_REACHED');
    const t = await r.create(req.body);
    await audit(req, { action: 'terminal.created', entity: 'terminal', entityId: t._id, after: t });
    created(res, present(t));
  }),
);

terminalsRouter.patch(
  '/:id',
  idParams,
  requirePermission('terminals.manage'),
  validate({ body: terminalUpdateSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const r = repo(req, Terminal);
    const t = await r.findById(req.params.id);
    if (!t) throw notFound('TERMINAL_NOT_FOUND');
    if (req.body.branchId && !(await repo(req, Branch).exists({ _id: req.body.branchId }))) throw notFound('BRANCH_NOT_FOUND');
    if (req.body.isActive === true && !t.isActive && (await r.count({ isActive: true })) >= a.shop!.limits!.maxTerminals) {
      throw unprocessable('LIMIT_REACHED');
    }
    const { printerProfile, ...rest } = req.body;
    Object.assign(t, rest);
    if (printerProfile) Object.assign(t.printerProfile!, printerProfile);
    await t.save();
    await audit(req, { action: 'terminal.updated', entity: 'terminal', entityId: t._id, after: req.body });
    ok(res, present(t));
  }),
);

/** 6-digit code valid for 10 minutes; entered once in the local agent window (spec 9.3). */
terminalsRouter.post(
  '/:id/pairing-code',
  idParams,
  requirePermission('terminals.manage'),
  h(async (req, res) => {
    const t = await repo(req, Terminal).findById(req.params.id);
    if (!t) throw notFound('TERMINAL_NOT_FOUND');
    let code = '';
    // Codes are looked up without a shop id, so they must be unique among live codes platform-wide.
    for (let i = 0; i < 20; i++) {
      code = randomDigits(6);
      const clash = await Terminal.exists({ pairingCodeHash: sha256(code), pairingExpiresAt: { $gt: new Date() } }).setOptions({ crossTenant: true });
      if (!clash) break;
    }
    t.pairingCodeHash = sha256(code);
    t.pairingExpiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await t.save();
    await audit(req, { action: 'terminal.pairing_code_created', entity: 'terminal', entityId: t._id });
    ok(res, { code, expiresAt: t.pairingExpiresAt });
  }),
);

/** Revoke the paired agent: its token stops working immediately. */
terminalsRouter.delete(
  '/:id/agent',
  idParams,
  requirePermission('terminals.manage'),
  h(async (req, res) => {
    const t = await repo(req, Terminal).findById(req.params.id);
    if (!t) throw notFound('TERMINAL_NOT_FOUND');
    t.set({ agentTokenHash: undefined, agentSecretEncrypted: undefined, agentMachineId: undefined, pairingCodeHash: undefined, pairingExpiresAt: undefined });
    agentHub.disconnectTerminal(String(t._id));
    await t.save();
    await audit(req, { action: 'terminal.agent_revoked', entity: 'terminal', entityId: t._id });
    ok(res, present(t));
  }),
);
