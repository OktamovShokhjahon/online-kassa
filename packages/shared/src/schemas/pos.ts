import { z } from 'zod';
import { HISTORY_TYPES, SALE_PAYMENT_METHODS } from '../constants';
import { PROMOTION_TYPES } from '../promotions';
import { isoDate, moneySchema, objectId, paginationSchema, phoneSchema } from './common';
import { qtySchema } from './stock';

/* ------------------------------------------------------------------------- shifts */

export const shiftOpenSchema = z.object({ terminalId: objectId, openingCash: moneySchema.default(0) });
export const shiftCloseSchema = z.object({
  countedCash: moneySchema,
  /** The POS must have sent every queued offline sale before closing. */
  unsentOfflineCount: z.number().int().min(0).default(0),
  note: z.string().trim().max(300).optional(),
});
export const cashOperationSchema = z.object({
  shiftId: objectId,
  type: z.enum(['in', 'out']),
  amount: moneySchema.positive(),
  comment: z.string().trim().min(1).max(300),
});
export const removedLinesSchema = z.object({
  items: z.array(z.object({ productId: objectId.optional(), name: z.string().max(200), qty: z.number(), price: z.number().int().optional(), reason: z.enum(['line_removed', 'cart_cleared', 'qty_decreased']).default('line_removed') })).min(1).max(200),
});

/* -------------------------------------------------------------------------- sales */

export const managerApprovalSchema = z.object({ login: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) });

export const saleLineInputSchema = z.object({
  productId: objectId,
  qty: qtySchema,
  /** Honoured only for offline sales ("keep the price actually charged"); online prices come from the server. */
  price: moneySchema.optional(),
  /** Manual discount on this line, minor units. */
  discount: moneySchema.default(0),
  /** Offline sales only: the promotion the POS applied while offline, kept as charged. */
  promotionId: objectId.optional(),
  promoDiscount: moneySchema.optional(),
  /** DataMatrix marking code of a marked unit (qty must be 1). */
  markingCode: z.string().trim().min(1).max(300).optional(),
});

export const saleInputSchema = z.object({
  clientRequestId: z.string().trim().min(8).max(64),
  terminalId: objectId,
  shiftId: objectId,
  customerId: objectId.optional(),
  lines: z.array(saleLineInputSchema).min(1).max(300),
  /** Manual discount on the whole receipt, minor units. */
  discount: moneySchema.default(0),
  payments: z.array(z.object({ method: z.enum(SALE_PAYMENT_METHODS), amount: moneySchema.positive() })).min(1).max(4),
  isOffline: z.boolean().default(false),
  localNumber: z.string().trim().max(40).optional(),
  createdAt: isoDate.optional(),
  approval: managerApprovalSchema.optional(),
});
export type SaleInput = z.infer<typeof saleInputSchema>;

export const salesSyncSchema = z.object({ sales: z.array(saleInputSchema).min(1).max(100) });

export const saleListQuerySchema = paginationSchema.extend({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  customerId: objectId.optional(),
  shiftId: objectId.optional(),
  productId: objectId.optional(),
  number: z.string().max(40).optional(),
  status: z.enum(['completed', 'refunded', 'partially_refunded']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  offline: z.enum(['true']).optional(),
});

export const refundInputSchema = z.object({
  saleId: objectId,
  lines: z.array(z.object({ productId: objectId, lineIndex: z.number().int().min(0).optional(), qty: qtySchema })).min(1).max(300),
  reason: z.string().trim().min(2).max(300),
  method: z.enum(['cash', 'card', 'debt']),
  /** Goods go back to stock by default; "writeoff" for damaged goods. */
  restock: z.enum(['stock', 'writeoff']).default('stock'),
  clientRequestId: z.string().trim().min(8).max(64).optional(),
  approval: managerApprovalSchema.optional(),
});

export const printJobSchema = z.object({
  terminalId: objectId,
  type: z.enum(['print.receipt', 'print.label', 'print.report', 'drawer.open', 'print.test']),
  payload: z.record(z.unknown()).default({}),
});

/* --------------------------------------------------------------------- customers */

export const customerInputSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: phoneSchema,
  cardBarcode: z.string().trim().min(1).max(128).optional(),
  birthday: isoDate.optional(),
  note: z.string().trim().max(500).optional(),
  creditLimit: moneySchema.optional(),
});
export const customerUpdateSchema = customerInputSchema.partial();
export const customerListQuerySchema = paginationSchema.extend({ debtOnly: z.enum(['true']).optional() });
export const customerPaymentSchema = z.object({
  customerId: objectId,
  shiftId: objectId.optional(),
  amount: moneySchema.positive(),
  method: z.enum(['cash', 'card']),
});

/* ------------------------------------------------------------------- promotions */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const promotionInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(PROMOTION_TYPES),
    priority: z.number().int().min(0).max(1000).default(0),
    allowStack: z.boolean().default(false),
    isActive: z.boolean().default(true),
    startsAt: isoDate.nullable().optional(),
    endsAt: isoDate.nullable().optional(),
    branchIds: z.array(objectId).default([]),
    schedule: z.object({ days: z.array(z.number().int().min(0).max(6)).max(7).optional(), from: hhmm.optional(), to: hhmm.optional() }).nullable().optional(),
    rules: z.object({
      percent: z.number().min(0).max(100).optional(),
      amount: moneySchema.optional(),
      productIds: z.array(objectId).max(500).optional(),
      categoryIds: z.array(objectId).max(100).optional(),
      buyQty: z.number().int().min(1).max(1000).optional(),
      getQty: z.number().int().min(1).max(1000).optional(),
      items: z.array(z.object({ productId: objectId, qty: z.number().int().min(1).max(1000) })).max(20).optional(),
      bundlePrice: moneySchema.optional(),
    }),
  })
  .superRefine((p, ctx) => {
    const r = p.rules;
    const need = (cond: boolean, path: string) => cond || ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', path], message: 'Required for this promotion type' });
    if (p.type === 'percent') need(r.percent !== undefined && r.percent > 0, 'percent');
    if (p.type === 'fixed') need(r.amount !== undefined && r.amount > 0, 'amount');
    if (p.type === 'buy_x_get_y') {
      need(r.buyQty !== undefined, 'buyQty');
      need(r.getQty !== undefined, 'getQty');
    }
    if (p.type === 'bundle') {
      need(!!r.items && r.items.length >= 2, 'items');
      need(r.bundlePrice !== undefined && r.bundlePrice > 0, 'bundlePrice');
    }
    if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'endsAt must be after startsAt' });
  });

/** History feed (sales, declined receipts, refunds, arrivals, shifts, cash in/out). */
export const historyQuerySchema = paginationSchema.extend({
  type: z.enum(HISTORY_TYPES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: objectId.optional(),
  terminalId: objectId.optional(),
});

/** A receipt the cash-desk program cleared before payment. */
export const deskDeclinedSchema = z.object({
  clientEventId: z.string().trim().min(8).max(64),
  lines: z.array(z.object({ productId: objectId.optional(), name: z.string().trim().max(300), qty: z.number().positive().max(1_000_000), price: z.number().int().min(0).nullable().optional() })).min(1).max(300),
  total: z.number().int().min(0).default(0),
  createdAt: isoDate.optional(),
});
