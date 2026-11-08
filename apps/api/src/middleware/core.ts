import crypto from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { DEFAULT_LANGUAGE, parseAcceptLanguage, translate } from '@kass/shared';
import { AppError, badRequest, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { TenantGuardError } from '../db/tenantGuard';
import { events } from '../lib/events';

/** Request ID + language detection (Accept-Language: uz | ru | en). */
export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = String(req.headers['x-request-id'] ?? crypto.randomUUID());
  req.lang = parseAcceptLanguage(req.headers['accept-language']) ?? DEFAULT_LANGUAGE;
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** Rejects `$`-prefixed or dotted keys anywhere in the input (NoSQL operator injection). */
function hasBadKey(value: unknown, depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasBadKey(v, depth + 1));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('$') || k.includes('.')) return true;
    if (hasBadKey(v, depth + 1)) return true;
  }
  return false;
}

export const noSqlGuard: RequestHandler = (req, _res, next) => {
  // Webhook/free-form payload fields are validated separately; keys with `$` are never legitimate here.
  if (hasBadKey(req.body) || hasBadKey(req.query) || hasBadKey(req.params)) {
    return next(badRequest('BAD_REQUEST'));
  }
  next();
};

export const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      id: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - start,
      user: req.auth?.userId ? String(req.auth.userId) : undefined,
    });
  });
  next();
};

type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };

/** Zod validation (spec 13.3 step 7). Parsed values replace the raw input. */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) (req as any).query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound());

function zodDetails(err: ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function duplicateCode(err: any): string {
  const fields = Object.keys(err.keyPattern ?? err.keyValue ?? {});
  if (fields.includes('login')) return 'LOGIN_TAKEN';
  if (fields.includes('barcodes')) return 'DUPLICATE_BARCODE';
  if (fields.includes('sku')) return 'DUPLICATE_SKU';
  return 'DUPLICATE';
}

let lastServerErrorAlert = 0;
/** Platform alert (Telegram to the superadmin), at most one per minute. */
function notifyServerError(err: any, req: Request) {
  if (env.isTest || Date.now() - lastServerErrorAlert < 60_000) return;
  lastServerErrorAlert = Date.now();
  events.emit({ name: 'server.error', shopId: '', data: { message: String(err?.message ?? err), requestId: req.requestId } });
}

export const errorHandler: ErrorRequestHandler = (err, req: Request, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let details: unknown;
  let params: AppError['params'];

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    details = err.details;
    params = err.params;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    details = zodDetails(err);
  } else if (err?.code === 11000) {
    status = 409;
    code = duplicateCode(err);
    details = { fields: Object.keys(err.keyPattern ?? {}) };
  } else if (err?.name === 'CastError' || err?.name === 'ValidationError') {
    status = 400;
    code = 'VALIDATION_ERROR';
    details = err.errors ? Object.keys(err.errors).map((k) => ({ path: k, message: err.errors[k].message })) : undefined;
  } else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    status = 400;
    code = 'BAD_REQUEST';
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    code = 'BAD_REQUEST';
  } else if (err instanceof TenantGuardError) {
    // A programming error: surface loudly in logs, never leak data.
    logger.error('tenant guard violation', { id: req.requestId, err: err.message });
  }

  if (status >= 500) {
    notifyServerError(err, req);
    logger.error('unhandled error', {
      id: req.requestId,
      path: req.originalUrl,
      err: err instanceof Error ? err.stack : String(err),
    });
  }

  const message = translate(req.lang ?? DEFAULT_LANGUAGE, `errors.${code}`, params);
  res.status(status).json({
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      ...(env.isProd ? {} : status >= 500 ? { debug: String(err?.message ?? err) } : {}),
    },
  });
};
