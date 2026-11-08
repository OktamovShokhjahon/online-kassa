import { Router } from 'express';
import { z } from 'zod';
import { settingsUpdateSchema } from '@kass/shared';
import { audit } from '../../lib/audit';
import { badRequest, unprocessable } from '../../lib/errors';
import { auth, h, ok } from '../../lib/http';
import { handleUpload, imageUpload, storeImage } from '../../lib/storage';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Shop } from '../../models/core';
import { publicShop } from '../auth/service';

export const settingsRouter = Router();
settingsRouter.use(authenticate);

/** Any shop user may read the shop settings (the POS needs them); only the admin edits them. */
settingsRouter.get(
  '/',
  h(async (req, res) => {
    const a = auth(req);
    if (!a.shop) throw badRequest();
    ok(res, await publicShop(a.shop));
  }),
);

settingsRouter.patch(
  '/',
  requirePermission('settings.manage'),
  validate({ body: settingsUpdateSchema }),
  h(async (req, res) => {
    const a = auth(req);
    const b = req.body as z.infer<typeof settingsUpdateSchema>;
    const shop = (await Shop.findById(a.shopId))!;
    const before = shop.toObject();

    if (b.currency !== undefined && b.currency !== shop.currency) {
      // Amounts are never converted, so the currency is locked after the first posted document or sale.
      if (shop.currencyLocked) throw unprocessable('CURRENCY_LOCKED');
      shop.currency = b.currency;
    }
    if (b.name !== undefined) shop.name = b.name;
    if (b.address !== undefined) shop.address = b.address;
    if (b.tin !== undefined) {
      if (shop.fiscalEnabled) throw badRequest('FORBIDDEN'); // fiscal TIN is managed by the superadmin
      shop.tin = b.tin;
    }
    const s = shop.settings!;
    if (b.allowNegativeStock !== undefined) s.allowNegativeStock = b.allowNegativeStock;
    if (b.maxCashierDiscount !== undefined) s.maxCashierDiscount = b.maxCashierDiscount;
    if (b.receiptLanguage !== undefined) s.receiptLanguage = b.receiptLanguage;
    if (b.receiptHeader !== undefined) s.receiptHeader = b.receiptHeader;
    if (b.receiptFooter !== undefined) s.receiptFooter = b.receiptFooter;
    if (b.openShiftAlertHours !== undefined) s.openShiftAlertHours = b.openShiftAlertHours;
    if (b.loyalty) Object.assign(s.loyalty!, b.loyalty);
    await shop.save();

    await audit(req, { action: 'settings.updated', entity: 'shop', entityId: shop._id, before: before.settings && { ...before.settings, currency: before.currency }, after: { ...shop.settings, currency: shop.currency } });
    ok(res, await publicShop(shop));
  }),
);

settingsRouter.post(
  '/logo',
  requirePermission('settings.manage'),
  handleUpload(imageUpload),
  h(async (req, res) => {
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) throw badRequest('FILE_TYPE_INVALID');
    const stored = await storeImage(`logos/${auth(req).shopId}`, file.buffer);
    await Shop.updateOne({ _id: auth(req).shopId }, { logoUrl: stored.url });
    await audit(req, { action: 'settings.logo_changed', entity: 'shop', entityId: auth(req).shopId! });
    ok(res, { logoUrl: stored.url });
  }),
);
