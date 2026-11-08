import { z } from 'zod';
import { UNITS } from '../constants';
import { moneySchema, objectId, paginationSchema } from './common';

const emptyToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: objectId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});
export const categoryMoveProductsSchema = z.object({ toCategoryId: objectId.nullable() });

/** MXIK (IKPU) classifier codes are 17 digits. */
export const mxikSchema = z.string().regex(/^\d{17}$/, 'MXIK code must have 17 digits');
export const packageCodeSchema = z.string().regex(/^\d{1,10}$/, 'Package code must be numeric');

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.preprocess(emptyToUndef, z.string().trim().max(64).optional()),
  barcodes: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
  categoryId: objectId.nullable().optional(),
  unit: z.enum(UNITS).default('piece'),
  isWeighted: z.boolean().default(false),
  vatRate: z.number().min(0).max(100).nullable().optional(),
  mxikCode: z.preprocess(emptyToUndef, mxikSchema.nullable().optional()),
  packageCode: z.preprocess(emptyToUndef, packageCodeSchema.nullable().optional()),
  isMarked: z.boolean().default(false),
  isActive: z.boolean().default(true),
  /** Purchase (cost) price per unit, minor units: profit = selling price - cost price. Shop admin only. */
  costPrice: moneySchema.nullable().optional(),
  /** Optional initial selling prices per branch (shop admin only). */
  prices: z.array(z.object({ branchId: objectId, price: moneySchema.positive() })).max(200).optional(),
});
export const productUpdateSchema = productInputSchema.partial().omit({ prices: true });

export const productListQuerySchema = paginationSchema.extend({
  categoryId: objectId.optional(),
  active: z.enum(['true', 'false']).optional(),
  barcode: z.string().trim().max(128).optional(),
  /** Products without a selling price in this branch. */
  missingPriceBranchId: objectId.optional(),
  missingMxik: z.enum(['true']).optional(),
  stockStatus: z.enum(['low', 'negative', 'out', 'in']).optional(),
  branchId: objectId.optional(),
});

export const priceChangeItemSchema = z.object({
  productId: objectId,
  branchId: objectId,
  /** null removes the price: the product can no longer be sold in that branch. */
  price: moneySchema.positive().nullable(),
});
export const priceMatrixUpdateSchema = z.object({ changes: z.array(priceChangeItemSchema).min(1).max(5000) });

export const priceCopySchema = z.object({
  fromBranchId: objectId,
  toBranchIds: z.array(objectId).min(1).max(100),
  overwrite: z.boolean().default(false),
});

export const priceBulkSchema = z
  .object({
    branchIds: z.array(objectId).min(1).max(100),
    productIds: z.array(objectId).max(5000).optional(),
    categoryId: objectId.optional(),
    mode: z.enum(['percent', 'fixed']),
    /** percent: e.g. 10 or -5. fixed: signed minor units added to the price. */
    value: z.number().finite(),
  })
  .refine((v) => (v.productIds?.length ?? 0) > 0 || v.categoryId, { message: 'Select products or a category' });

export const scheduledPriceSchema = z.object({
  productId: objectId,
  branchId: objectId,
  newPrice: moneySchema.positive(),
  effectiveAt: z.coerce.date(),
});

export const priceMatrixQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  q: z.string().trim().max(100).optional(),
  categoryId: objectId.optional(),
  missingOnly: z.enum(['true']).optional(),
});

export const importMappingSchema = z.object({
  name: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  price: z.string().optional(),
  vatRate: z.string().optional(),
  mxikCode: z.string().optional(),
  packageCode: z.string().optional(),
  isMarked: z.string().optional(),
  isWeighted: z.string().optional(),
});
export type ImportMapping = z.infer<typeof importMappingSchema>;
export const IMPORT_FIELDS = Object.keys(importMappingSchema.shape) as Array<keyof ImportMapping>;

export const labelsSchema = z.object({
  branchId: objectId,
  items: z.array(z.object({ productId: objectId, copies: z.number().int().min(1).max(100).default(1) })).min(1).max(500),
});
