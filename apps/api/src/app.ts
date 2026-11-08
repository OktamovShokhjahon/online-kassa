import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { API_PREFIX } from '@kass/shared';
import { env } from './config/env';
import {
  errorHandler,
  noSqlGuard,
  notFoundHandler,
  requestContext,
  requestLogger,
} from './middleware/core';
import { buildRoutes } from './routes';
import { uploadRoot } from './lib/storage';

/**
 * Middleware chain (spec 13.3): request id/logging/language -> helmet/CORS/body limit ->
 * auth (per router) -> tenant check -> permission -> branch scope -> validation ->
 * controller -> central error handler.
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(requestLogger);
  app.use(compression());
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: env.WEB_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Codes-Count', 'X-Codes-Generated'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(noSqlGuard);

  // Uploaded logos/product images (public, unguessable file names).
  app.use('/uploads', express.static(uploadRoot(), { index: false, dotfiles: 'deny', maxAge: '7d' }));
  app.use(API_PREFIX, buildRoutes());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
