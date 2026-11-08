import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Model } from 'mongoose';
import { forbidden, unauthorized } from './errors';
import { TenantRepo } from '../repo/tenantRepo';
import type { AuthContext } from '../types';

/** Express 4 does not catch rejected promises; this wrapper forwards them to the error handler. */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function ok(res: Response, data: unknown, meta?: Record<string, unknown>, status = 200) {
  res.status(status).json(meta ? { data, meta } : { data });
}

export const created = (res: Response, data: unknown) => ok(res, data, undefined, 201);

/** Authenticated user context or 401. */
export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * Tenant-scoped repository for the caller's shop. `shopId` is taken from the session only.
 * The superadmin has no shop and therefore cannot obtain one (impersonation issues a
 * shop-admin session instead).
 */
export function repo<T>(req: Request, model: Model<T>): TenantRepo<T> {
  const a = auth(req);
  if (!a.shopId) throw forbidden();
  return new TenantRepo<T>(model, a.shopId);
}

export function shopId(req: Request) {
  const a = auth(req);
  if (!a.shopId) throw forbidden();
  return a.shopId;
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || '';
}
