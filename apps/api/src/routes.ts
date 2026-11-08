import { Router } from 'express';
import mongoose from 'mongoose';
import { adminRouter } from './modules/admin/routes';
import { authRouter } from './modules/auth/routes';
import { categoriesRouter } from './modules/catalog/categories';
import { priceChangesRouter, pricesRouter } from './modules/catalog/prices';
import { productsRouter } from './modules/catalog/products';
import { goodsReceiptsRouter, stockCountsRouter, supplierReturnsRouter, transfersRouter, writeOffsRouter } from './modules/stock/documents';
import { stockRouter } from './modules/stock/stock';
import { suppliersRouter, supplierPaymentsRouter } from './modules/stock/suppliers';
import { agentRouter } from './modules/agent/routes';
import { customerPaymentsRouter, customersRouter, promotionsRouter } from './modules/customers/routes';
import { fiscalRouter } from './modules/fiscal/routes';
import { cashOperationsRouter, posRouter, refundsRouter, salesRouter, shiftsRouter } from './modules/pos/routes';
import { reportsRouter } from './modules/reports/routes';
import { apiKeysRouter } from './modules/developers/apiKeys';
import { docsRouter } from './modules/developers/openapi';
import { publicRouter } from './modules/developers/publicApi';
import { webhooksRouter } from './modules/developers/webhooks';
import { adminProgramsRouter } from './modules/programs/admin';
import { deskRouter } from './modules/programs/desk';
import { auditLogRouter } from './modules/shop/auditLog';
import { adminTelegramRouter, telegramRouter } from './modules/telegram/routes';
import { branchesRouter } from './modules/shop/branches';
import { settingsRouter } from './modules/shop/settings';
import { staffRouter } from './modules/shop/staff';
import { terminalsRouter } from './modules/shop/terminals';
import { h, ok } from './lib/http';

/** All `/api/v1` routes. Later stages register their routers here. */
export function buildRoutes(): Router {
  const r = Router();

  r.get(
    '/health',
    h(async (_req, res) => {
      const dbUp = mongoose.connection.readyState === 1;
      res.status(dbUp ? 200 : 503);
      ok(res, { status: dbUp ? 'ok' : 'degraded', db: dbUp, uptime: Math.round(process.uptime()) });
    }),
  );

  r.use('/auth', authRouter);
  r.use('/admin/telegram', adminTelegramRouter);
  r.use('/admin/shops/:id/programs', adminProgramsRouter);
  r.use('/admin', adminRouter);

  // shop workspace (tenant-scoped)
  r.use('/settings', settingsRouter);
  r.use('/branches', branchesRouter);
  r.use('/terminals', terminalsRouter);
  r.use('/users', staffRouter);
  r.use('/categories', categoriesRouter);
  r.use('/products', productsRouter);
  r.use('/prices', pricesRouter);
  r.use('/price-changes', priceChangesRouter);

  // suppliers and stock (Stage 4)
  r.use('/suppliers', suppliersRouter);
  r.use('/supplier-payments', supplierPaymentsRouter);
  r.use('/goods-receipts', goodsReceiptsRouter);
  r.use('/supplier-returns', supplierReturnsRouter);
  r.use('/transfers', transfersRouter);
  r.use('/write-offs', writeOffsRouter);
  r.use('/stock-counts', stockCountsRouter);
  r.use('/stock', stockRouter);

  // POS, customers, agents (Stage 5-6, 8)
  r.use('/shifts', shiftsRouter);
  r.use('/cash-operations', cashOperationsRouter);
  r.use('/sales', salesRouter);
  r.use('/refunds', refundsRouter);
  r.use('/pos', posRouter);
  r.use('/customers', customersRouter);
  r.use('/customer-payments', customerPaymentsRouter);
  r.use('/promotions', promotionsRouter);
  r.use('/fiscal', fiscalRouter);
  r.use('/reports', reportsRouter);

  // integrations (Stage 7)
  r.use('/api-keys', apiKeysRouter);
  r.use('/webhooks', webhooksRouter);
  r.use('/telegram', telegramRouter);
  r.use('/audit-logs', auditLogRouter);
  r.use('/docs', docsRouter);
  r.use('/public', publicRouter);
  r.use('/desk', deskRouter);
  r.use('/agent', agentRouter);

  return r;
}
