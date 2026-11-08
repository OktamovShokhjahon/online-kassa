import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { LANGUAGES, objectId } from '@kass/shared';
import { audit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { notFound, unprocessable } from '../../lib/errors';
import { auth, created, h, ok } from '../../lib/http';
import { authenticate, requireRole } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Branch, Shop, Terminal, User } from '../../models/core';
import { ApiKey } from '../../models/integrations';

/**
 * Superadmin: downloadable programs of one shop (Programs tab of the shop page). Downloading
 * the cash-desk program creates a key bound to one terminal and cashier and writes it, with the
 * scanner and printer settings, into the Python file. The key is never shown anywhere else.
 */
export const adminProgramsRouter = Router({ mergeParams: true });
adminProgramsRouter.use(authenticate, requireRole('superadmin'));

const DESK_ROLES = ['cashier', 'branch_manager', 'shop_admin'];
const shopParams = validate({ params: z.object({ id: objectId }) });

async function findShop(id: string) {
  const shop = await Shop.findById(id);
  if (!shop) throw notFound();
  return shop;
}

const presentProgram = (k: any, names: { terminals: Map<string, string>; users: Map<string, string> }) => ({
  id: String(k._id),
  kind: k.program.kind,
  name: k.name,
  display: `${k.prefix}…${k.last4}`,
  terminalId: String(k.program.terminalId),
  terminalName: names.terminals.get(String(k.program.terminalId)) ?? '—',
  cashierId: String(k.program.cashierId),
  cashierName: names.users.get(String(k.program.cashierId)) ?? '—',
  settings: k.program.settings ?? null,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt ?? null,
  requestCount: k.requestCount ?? 0,
  revokedAt: k.revokedAt ?? null,
  active: !k.revokedAt,
});

adminProgramsRouter.get(
  '/',
  shopParams,
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const [terminals, branches, users, keys] = await Promise.all([
      Terminal.find({ shopId: shop._id }).sort('name').lean(),
      Branch.find({ shopId: shop._id }).select('name').lean(),
      User.find({ shopId: shop._id, isActive: true, role: { $in: DESK_ROLES } }).select('fullName role login branchIds').sort('fullName').lean(),
      ApiKey.find({ shopId: shop._id, 'program.kind': 'desk' }).sort('-createdAt').limit(100).lean(),
    ]);
    const branchName = new Map(branches.map((b) => [String(b._id), b.name]));
    const allUsers = await User.find({ shopId: shop._id, _id: { $in: keys.map((k: any) => k.program.cashierId) } }).select('fullName').lean();
    const names = { terminals: new Map(terminals.map((t) => [String(t._id), t.name])), users: new Map(allUsers.map((u) => [String(u._id), u.fullName])) };
    ok(res, {
      terminals: terminals.map((t) => ({ id: String(t._id), name: t.name, branchId: String(t.branchId), branchName: branchName.get(String(t.branchId)) ?? '', isActive: t.isActive })),
      cashiers: users.map((u) => ({ id: String(u._id), fullName: u.fullName, role: u.role, login: u.login, branchIds: (u.branchIds ?? []).map(String) })),
      programs: keys.map((k) => presentProgram(k, names)),
    });
  }),
);

const deskProgramSchema = z.object({
  terminalId: objectId,
  cashierId: objectId,
  apiUrl: z.string().trim().url().max(300),
  language: z.enum(LANGUAGES),
  scanner: z.object({
    port: z.string().trim().max(40).default('auto'),
    baudrate: z.coerce.number().int().min(1200).max(921600).default(9600),
  }),
  printer: z.object({
    type: z.enum(['windows', 'serial', 'network', 'file', 'none']).default('windows'),
    name: z.string().trim().max(200).default(''),
    port: z.string().trim().max(40).default(''),
    baudrate: z.coerce.number().int().min(1200).max(921600).default(9600),
    host: z.string().trim().max(200).default(''),
    tcpPort: z.coerce.number().int().min(1).max(65535).default(9100),
    paperMm: z.union([z.literal(58), z.literal(80)]).default(58),
    codePage: z.enum(['CP866', 'CP437', 'CP1251', 'WPC1252']).default('CP866'),
    cut: z.boolean().default(false),
    drawer: z.boolean().default(false),
  }),
});

adminProgramsRouter.post(
  '/desk',
  shopParams,
  validate({ body: deskProgramSchema }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const b = req.body as z.infer<typeof deskProgramSchema>;
    const terminal = await Terminal.findOne({ _id: b.terminalId, shopId: shop._id });
    if (!terminal) throw notFound('TERMINAL_NOT_FOUND');
    if (!terminal.isActive) throw unprocessable('TERMINAL_INACTIVE');
    const cashier = await User.findOne({ _id: b.cashierId, shopId: shop._id, isActive: true });
    if (!cashier || !DESK_ROLES.includes(cashier.role)) throw notFound('CASHIER_NOT_FOUND');
    if (cashier.role !== 'shop_admin' && !(cashier.branchIds ?? []).some((x) => String(x) === String(terminal.branchId))) throw unprocessable('TERMINAL_BRANCH_MISMATCH');
    const branch = await Branch.findOne({ _id: terminal.branchId, shopId: shop._id });

    const settings = { scanner: b.scanner, printer: b.printer, language: b.language };
    const secret = `kk_live_${randomToken(32)}`;
    const key = await ApiKey.create({
      shopId: shop._id,
      name: `Desk program · ${terminal.name}`,
      scopes: [],
      branchId: terminal.branchId,
      prefix: secret.slice(0, 12),
      last4: secret.slice(-4),
      keyHash: sha256(secret),
      createdBy: auth(req).userId,
      program: { kind: 'desk', terminalId: terminal._id, cashierId: cashier._id, settings },
    });
    await audit(req, { action: 'shop.program_downloaded', entity: 'shop', entityId: String(shop._id), shopId: null, meta: { program: 'desk', keyId: String(key._id), terminalId: String(terminal._id), cashierId: String(cashier._id) } });
    await audit(req, { action: 'api_key.created', entity: 'api_key', entityId: key._id, shopId: shop._id, meta: { name: key.name, program: 'desk' } });

    const content = renderDeskProgram({
      api_url: b.apiUrl.replace(/\/+$/, ''),
      api_key: secret,
      shop_name: shop.name,
      branch_name: branch?.name ?? '',
      terminal_id: String(terminal._id),
      terminal_name: terminal.name,
      cashier_name: cashier.fullName,
      currency: shop.currency,
      language: b.language,
      fiscal: !!shop.fiscalEnabled,
      scanner: { port: b.scanner.port || 'auto', baudrate: b.scanner.baudrate },
      printer: {
        type: b.printer.type, name: b.printer.name, port: b.printer.port, baudrate: b.printer.baudrate, host: b.printer.host,
        tcp_port: b.printer.tcpPort, paper_mm: b.printer.paperMm, code_page: b.printer.codePage, cut: b.printer.cut, drawer: b.printer.drawer,
      },
    });
    const names = { terminals: new Map([[String(terminal._id), terminal.name]]), users: new Map([[String(cashier._id), cashier.fullName]]) };
    created(res, { program: presentProgram(key.toObject(), names), filename: `kassa_desk_${slug(terminal.name)}.py`, content });
  }),
);

adminProgramsRouter.delete(
  '/:keyId',
  validate({ params: z.object({ id: objectId, keyId: objectId }) }),
  h(async (req, res) => {
    const shop = await findShop(req.params.id);
    const key = await ApiKey.findOneAndUpdate({ _id: req.params.keyId, shopId: shop._id, 'program.kind': { $exists: true }, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true });
    if (!key) throw notFound();
    await audit(req, { action: 'shop.program_revoked', entity: 'shop', entityId: String(shop._id), shopId: null, meta: { keyId: String(key._id) } });
    ok(res, { id: String(key._id), revokedAt: key.revokedAt });
  }),
);

/* ---------------------------------------------------------------------- file generation */

const slug = (s: string) => s.normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'terminal';

let template: string | null = null;
function loadTemplate(): string {
  if (template) return template;
  const candidates = [
    process.env.DESK_PROGRAM_TEMPLATE,
    path.resolve(__dirname, '../../../assets/programs/kassa_desk.py'), // src/modules/programs
    path.resolve(__dirname, '../assets/programs/kassa_desk.py'), // dist
    path.resolve(process.cwd(), 'assets/programs/kassa_desk.py'),
    path.resolve(process.cwd(), 'apps/api/assets/programs/kassa_desk.py'),
  ].filter(Boolean) as string[];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error('kassa_desk.py template not found');
  template = fs.readFileSync(file, 'utf8');
  return template;
}

/** JSON-ish value -> Python literal (strings use JSON escapes, which Python understands). */
export function pyLiteral(v: unknown, indent = 0): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return JSON.stringify(v).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  if (Array.isArray(v)) return '[' + v.map((x) => pyLiteral(x, indent)).join(', ') + ']';
  const pad = ' '.repeat(indent);
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  const flat = entries.every(([, x]) => x === null || typeof x !== 'object');
  if (flat && indent > 0) return '{' + entries.map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ') + '}';
  return '{\n' + entries.map(([k, x]) => `${pad}    ${JSON.stringify(k)}: ${pyLiteral(x, indent + 4)},`).join('\n') + `\n${pad}}`;
}

export function renderDeskProgram(config: Record<string, unknown>): string {
  const src = loadTemplate().replace(/\r\n/g, '\n');
  const start = src.indexOf('# >>> CONFIG\n');
  const end = src.indexOf('# <<< CONFIG');
  if (start < 0 || end < start) throw new Error('kassa_desk.py template has no CONFIG block');
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const block = `# >>> CONFIG  (generated ${stamp} for ${String(config.shop_name)} / ${String(config.terminal_name)}; keep this file private: it contains the key)\nCONFIG = ${pyLiteral(config)}\n`;
  return src.slice(0, start) + block + src.slice(end);
}
