import { z } from 'zod';
import { PAYMENT_METHODS } from '../constants';
import { isoDate, moneySchema, objectId, paginationSchema, phoneSchema } from './common';

/** Quantity: positive, at most 3 decimals (weighed goods). */
export const qtySchema = z
  .number()
  .positive()
  .max(1_000_000_000)
  .refine((q) => Math.abs(Math.round(q * 1000) - q * 1000) < 1e-6, 'At most 3 decimals');

export const supplierInputSchema = z.object({
  name: z.string().trim().min(1).max(150),
  contactPerson: z.string().trim().max(100).optional(),
  phone: phoneSchema.optional(),
  address: z.string().trim().max(300).optional(),
  tin: z.string().regex(/^\d{9}$/).optional(),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  note: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});
export const supplierUpdateSchema = supplierInputSchema.partial();

export const supplierPaymentSchema = z.object({
  supplierId: objectId,
  amount: moneySchema.positive(),
  method: z.enum(PAYMENT_METHODS),
  paidAt: isoDate.default(() => new Date()),
  comment: z.string().trim().max(500).optional(),
});

export const statementQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

const receiptLine = z.object({ productId: objectId, qty: qtySchema, cost: moneySchema });
export const goodsReceiptInputSchema = z.object({
  supplierId: objectId,
  branchId: objectId,
  invoiceNo: z.string().trim().max(64).optional(),
  invoiceDate: isoDate.optional(),
  lines: z.array(receiptLine).min(1).max(1000),
  note: z.string().trim().max(500).optional(),
  /** Create and post in one step. */
  post: z.boolean().default(false),
});
export const goodsReceiptUpdateSchema = goodsReceiptInputSchema.omit({ post: true }).partial();

export const supplierReturnInputSchema = z.object({
  supplierId: objectId,
  branchId: objectId,
  goodsReceiptId: objectId.optional(),
  lines: z.array(receiptLine).min(1).max(1000),
  reason: z.string().trim().min(2).max(300),
  post: z.boolean().default(false),
});

export const transferInputSchema = z.object({
  fromBranchId: objectId,
  toBranchId: objectId,
  lines: z.array(z.object({ productId: objectId, qty: qtySchema })).min(1).max(1000),
  note: z.string().trim().max(500).optional(),
});
export const transferReceiveSchema = z.object({
  /** Defaults to everything sent. Differences are recorded as a discrepancy. */
  lines: z.array(z.object({ productId: objectId, qtyReceived: z.number().min(0).max(1_000_000_000) })).optional(),
  note: z.string().trim().max(500).optional(),
});

export const WRITE_OFF_REASONS = ['damaged', 'expired', 'lost', 'internal_use'] as const;
export const writeOffInputSchema = z.object({
  branchId: objectId,
  reason: z.enum(WRITE_OFF_REASONS),
  comment: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: objectId, qty: qtySchema })).min(1).max(1000),
  post: z.boolean().default(false),
});

export const stockCountInputSchema = z.object({
  branchId: objectId,
  categoryId: objectId.optional(),
  note: z.string().trim().max(500).optional(),
  /** Pre-fill lines with every active product of the scope (counted left empty). */
  prefill: z.boolean().default(true),
});
export const stockCountLinesSchema = z.object({
  lines: z.array(z.object({ productId: objectId, counted: z.number().min(0).max(1_000_000_000).nullable() })).min(1).max(5000),
});
export const stockCountPostSchema = z.object({
  /** Products that were in scope but not counted are set to zero. Default: left unchanged. */
  zeroUncounted: z.boolean().default(false),
});

export const cancelSchema = z.object({ reason: z.string().trim().min(2).max(300) });

export const documentListQuerySchema = paginationSchema.extend({
  branchId: objectId.optional(),
  supplierId: objectId.optional(),
  status: z.string().max(20).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const stockQuerySchema = paginationSchema.extend({
  branchId: objectId,
  categoryId: objectId.optional(),
  status: z.enum(['low', 'negative', 'zero', 'positive']).optional(),
});
export const movementQuerySchema = paginationSchema.extend({
  productId: objectId.optional(),
  branchId: objectId.optional(),
  type: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export const minStockSchema = z.object({
  branchId: objectId,
  items: z.array(z.object({ productId: objectId, minStock: z.number().min(0).max(1_000_000_000) })).min(1).max(5000),
});

export const STOCK_MOVEMENT_TYPES = [
  'goods_receipt',
  'goods_receipt_reversal',
  'sale',
  'customer_return',
  'supplier_return',
  'supplier_return_reversal',
  'transfer_out',
  'transfer_in',
  'transfer_cancel',
  'write_off',
  'write_off_reversal',
  'count_adjustment',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
