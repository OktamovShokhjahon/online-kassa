import { z } from 'zod';
import { PAYMENT_METHODS, SHOP_EFFECTIVE_STATUSES } from '../constants';
import {
  currencySchema,
  isoDate,
  languageSchema,
  loginSchema,
  moneySchema,
  paginationSchema,
  passwordSchema,
  phoneSchema,
} from './common';

const limitsSchema = z.object({
  maxBranches: z.number().int().min(1).max(1000),
  maxTerminals: z.number().int().min(1).max(10000),
  maxEmployees: z.number().int().min(1).max(100000),
});

const tinSchema = z.string().regex(/^\d{9}$/, 'TIN must be 9 digits');

export const createShopSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    adminFullName: z.string().trim().min(2).max(100),
    adminPhone: phoneSchema,
    adminLogin: loginSchema,
    adminPassword: passwordSchema,
    firstBranchName: z.string().trim().min(1).max(100).default('Main branch'),
    address: z.string().trim().max(300).optional(),
    tin: tinSchema.optional(),
    currency: currencySchema.default('UZS'),
    fiscalEnabled: z.boolean().default(false),
    adminLanguage: languageSchema.default('uz'),
    paidUntil: isoDate.nullable().optional(),
    limits: limitsSchema.partial().optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.fiscalEnabled && !v.tin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tin'], message: 'TIN_REQUIRED' });
    }
  });
export type CreateShopInput = z.infer<typeof createShopSchema>;

export const updateShopSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  address: z.string().trim().max(300).optional(),
  tin: tinSchema.nullable().optional(),
  limits: limitsSchema.partial().optional(),
  paidUntil: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});

export const shopListQuerySchema = paginationSchema.extend({
  status: z.enum(SHOP_EFFECTIVE_STATUSES).optional(),
  fiscal: z.enum(['on', 'off']).optional(),
});

export const blockShopSchema = z.object({ reason: z.string().trim().min(2).max(500) });

export const fiscalSettingsSchema = z
  .object({
    fiscalEnabled: z.boolean(),
    tin: tinSchema.optional(),
  })
  .strict();

export const resetPasswordSchema = z.object({ newPassword: passwordSchema.optional() });

export const changeShopAdminSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  login: loginSchema,
  password: passwordSchema,
  language: languageSchema.default('uz'),
});

export const recordPaymentSchema = z
  .object({
    amount: moneySchema.positive(),
    currency: currencySchema,
    periodFrom: isoDate,
    periodTo: isoDate,
    paidAt: isoDate,
    method: z.enum(PAYMENT_METHODS),
    comment: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.periodTo > v.periodFrom, { message: 'periodTo must be after periodFrom', path: ['periodTo'] });

export const platformSettingsSchema = z.object({
  defaultLimits: limitsSchema.partial().optional(),
  graceDays: z.number().int().min(0).max(60).optional(),
  platformName: z.string().trim().min(1).max(100).optional(),
  logoUrl: z.string().trim().max(500).optional(),
  agentInstaller: z
    .object({ url: z.string().trim().max(500), version: z.string().trim().max(32) })
    .partial()
    .optional(),
  longShiftHours: z.number().int().min(1).max(168).optional(),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().trim().max(100).optional(),
  entity: z.string().trim().max(100).optional(),
  entityId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  userId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  shopId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
