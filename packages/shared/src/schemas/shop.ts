import { z } from 'zod';
import { PERMISSIONS, STAFF_ROLES } from '../constants';
import {
  currencySchema,
  languageSchema,
  loginSchema,
  objectId,
  paginationSchema,
  passwordSchema,
  phoneSchema,
} from './common';

export const settingsUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  address: z.string().trim().max(300).optional(),
  tin: z.string().regex(/^\d{9}$/, 'TIN must be 9 digits').optional(),
  currency: currencySchema.optional(),
  allowNegativeStock: z.boolean().optional(),
  maxCashierDiscount: z.number().min(0).max(100).optional(),
  receiptLanguage: languageSchema.optional(),
  receiptHeader: z.string().trim().max(200).optional(),
  receiptFooter: z.string().trim().max(200).optional(),
  openShiftAlertHours: z.number().int().min(1).max(168).optional(),
  loyalty: z
    .object({ bonusPercent: z.number().min(0).max(100), maxPayPercent: z.number().min(0).max(100) })
    .partial()
    .optional(),
});

export const branchInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(32).optional(),
  workingHours: z.string().trim().max(100).optional(),
  receiptHeader: z.string().trim().max(200).optional(),
  receiptFooter: z.string().trim().max(200).optional(),
  isActive: z.boolean().optional(),
  /** On creation: copy all selling prices from this branch (spec 5.5). */
  copyPricesFromBranchId: objectId.optional(),
});

const printerProfileSchema = z
  .object({
    connection: z.enum(['usb', 'serial', 'network']),
    printerName: z.string().max(200),
    host: z.string().max(200),
    port: z.number().int().min(1).max(65535),
    paperWidthMm: z.union([z.literal(58), z.literal(80)]),
    printWidthDots: z.number().int().min(100).max(1000),
    charsPerLine: z.number().int().min(16).max(64),
    codePage: z.enum(['CP866', 'CP437', 'CP1251', 'WPC1252']),
    cutEnabled: z.boolean(),
    drawerEnabled: z.boolean(),
  })
  .partial();

export const terminalInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  branchId: objectId,
  isActive: z.boolean().optional(),
  printerProfile: printerProfileSchema.optional(),
});
export const terminalUpdateSchema = terminalInputSchema.partial();

const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]);
const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits');

export const staffCreateSchema = z.object({
  role: z.enum(STAFF_ROLES as [string, ...string[]]),
  fullName: z.string().trim().min(2).max(100),
  phone: phoneSchema.optional(),
  login: loginSchema,
  password: passwordSchema,
  branchIds: z.array(objectId).max(100).default([]),
  permissions: permissionList,
  pin: pinSchema.optional(),
  language: languageSchema.default('uz'),
});

export const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  phone: phoneSchema.optional(),
  branchIds: z.array(objectId).max(100).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
  pin: pinSchema.nullable().optional(),
  language: languageSchema.optional(),
});

export const staffListQuerySchema = paginationSchema.extend({
  role: z.enum(STAFF_ROLES as [string, ...string[]]).optional(),
  branchId: objectId.optional(),
  active: z.enum(['true', 'false']).optional(),
});

export const staffResetPasswordSchema = z.object({ newPassword: passwordSchema.optional() });
export const staffStatusSchema = z.object({ isActive: z.boolean() });
