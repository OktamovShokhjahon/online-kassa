import type { ClientSession, Types } from 'mongoose';
import type { Request } from 'express';
import { AuditLog } from '../models/core';
import { logger } from './logger';

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string | Types.ObjectId;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  /** Override the shop; default is the caller's shop. null = platform-level entry. */
  shopId?: Types.ObjectId | null;
}

const SENSITIVE = /password|^pin$|token|secret|credential|hash|^key$|^apiKey$/i;

/** Removes secrets from snapshots before they are written to the audit trail. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof (value as any).toObject === 'function') value = (value as any).toObject();
  if (depth > 5 || typeof value !== 'object') return value;
  if (value instanceof Date || (value as any)._bsontype === 'ObjectId') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__v') continue;
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  }
  return out;
}

/** Writes an audit entry for the authenticated caller of `req`. Never throws into the request. */
export async function audit(req: Request, entry: AuditEntry, session?: ClientSession | null) {
  try {
    const a = req.auth;
    await AuditLog.create(
      [
        {
          shopId: entry.shopId !== undefined ? entry.shopId : (a?.shopId ?? null),
          userId: a?.userId,
          userName: a?.user?.fullName,
          role: a?.role,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ? String(entry.entityId) : undefined,
          before: scrub(entry.before),
          after: scrub(entry.after),
          meta: scrub(entry.meta),
          ip: req.ip,
          impersonatedBy: a?.impersonatedBy,
        },
      ],
      { session: session ?? undefined },
    );
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, err: String(err) });
  }
}

/** Audit entry not tied to a request (workers, login failures before auth). */
export async function auditSystem(entry: AuditEntry & { userId?: Types.ObjectId; ip?: string }) {
  try {
    await AuditLog.create({
      shopId: entry.shopId ?? null,
      userId: entry.userId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ? String(entry.entityId) : undefined,
      before: scrub(entry.before),
      after: scrub(entry.after),
      meta: scrub(entry.meta),
      ip: entry.ip,
    });
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, err: String(err) });
  }
}
