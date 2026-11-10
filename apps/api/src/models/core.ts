import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import {
  CURRENCIES,
  DEFAULT_PLATFORM_SETTINGS,
  LANGUAGES,
  PAYMENT_METHODS,
  ROLES,
  SHOP_STORED_STATUSES,
} from '@kass/shared';
import { tenantGuard } from '../db/tenantGuard';

const oid = Schema.Types.ObjectId;

/** Strips internals/secrets when a document is serialised to JSON. */
function cleanJson(hidden: string[] = []) {
  return {
    virtuals: false,
    versionKey: false,
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const k of hidden) delete ret[k];
      return ret;
    },
  };
}

/* ----------------------------------------------------------------------------- shops */

const limitsSchema = new Schema(
  {
    maxBranches: { type: Number, required: true },
    maxTerminals: { type: Number, required: true },
    maxEmployees: { type: Number, required: true },
  },
  { _id: false },
);

const shopSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: SHOP_STORED_STATUSES, default: 'active', index: true },
    blockReason: { type: String },
    blockedAt: { type: Date },
    /** Empty = trial. */
    paidUntil: { type: Date, default: null, index: true },
    limits: { type: limitsSchema, required: true },
    currency: { type: String, enum: CURRENCIES, default: 'UZS' },
    /** Locked after the first posted document or sale (amounts are never converted). */
    currencyLocked: { type: Boolean, default: false },
    tin: { type: String },
    address: { type: String },
    logoUrl: { type: String },
    fiscalEnabled: { type: Boolean, default: false, index: true },
    settings: {
      allowNegativeStock: { type: Boolean, default: true },
      maxCashierDiscount: { type: Number, default: 5 },
      receiptLanguage: { type: String, enum: LANGUAGES, default: 'uz' },
      receiptHeader: { type: String, default: '' },
      receiptFooter: { type: String, default: '' },
      loyalty: {
        bonusPercent: { type: Number, default: 0 },
        maxPayPercent: { type: Number, default: 50 },
      },
      openShiftAlertHours: { type: Number, default: 24 },
    },
    /** 1-9999, unique; embedded in internal EAN-13 barcodes (2 + shop code + sequence). */
    shopCode: { type: Number, unique: true, sparse: true },
    note: { type: String },
    expiryProcessedAt: { type: Date },
  },
  { timestamps: true, toJSON: cleanJson() },
);
shopSchema.index({ name: 'text' });
export type ShopDoc = HydratedDocument<InferSchemaType<typeof shopSchema>>;
export const Shop = mongoose.model('Shop', shopSchema);

/* ----------------------------------------------------------------------------- users */

const userSchema = new Schema(
  {
    role: { type: String, enum: ROLES, required: true },
    /** null for the superadmin. */
    shopId: { type: oid, ref: 'Shop', default: null },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String },
    /** Stored lower-case; unique across the whole platform so the login identifies the shop. */
    login: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: { type: String, required: true },
    /** The password encrypted with ENCRYPTION_KEY so the superadmin / shop owner can look it up. Never sent in toJSON. */
    passwordEnc: { type: String },
    pinHash: { type: String },
    branchIds: { type: [oid], default: [] },
    /** Extra permission codes granted on top of the role defaults. */
    permissions: { type: [String], default: [] },
    language: { type: String, enum: LANGUAGES, default: 'uz' },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    /** Bumped whenever role/permissions/branches/password change; embedded in access tokens. */
    permVersion: { type: Number, default: 1 },
  },
  { timestamps: true, toJSON: cleanJson(['passwordHash', 'passwordEnc', 'pinHash']) },
);
userSchema.index({ shopId: 1, role: 1 });
userSchema.index({ shopId: 1, isActive: 1 });
userSchema.plugin(tenantGuard);
export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = mongoose.model('User', userSchema);

/* -------------------------------------------------------------------------- sessions */

const sessionSchema = new Schema(
  {
    userId: { type: oid, ref: 'User', required: true, index: true },
    shopId: { type: oid, default: null, index: true },
    tokenHash: { type: String, required: true, index: true },
    /** Previous rotated token; presenting it again means theft -> the session is revoked. */
    prevTokenHash: { type: String },
    /** When the token last rotated: the previous one is still accepted for a moment (parallel tabs / requests). */
    rotatedAt: { type: Date },
    device: { type: String },
    ip: { type: String },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    impersonatedBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: cleanJson(['tokenHash', 'prevTokenHash']) },
);
// Keep expired sessions for a week for audit, then drop.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;
export const Session = mongoose.model('Session', sessionSchema);

/* ------------------------------------------------------------------------- payments */

const shopPaymentSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    periodFrom: { type: Date, required: true },
    periodTo: { type: Date, required: true },
    paidAt: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    comment: { type: String },
    createdBy: { type: oid, ref: 'User', required: true },
  },
  { timestamps: true, toJSON: cleanJson() },
);
shopPaymentSchema.index({ shopId: 1, paidAt: -1 });
shopPaymentSchema.plugin(tenantGuard);
export const ShopPayment = mongoose.model('ShopPayment', shopPaymentSchema);

/* ------------------------------------------------------------------------- branches */

const branchSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    address: { type: String },
    phone: { type: String },
    workingHours: { type: String },
    /** Short number used in receipt numbers (`<code>-<sequence>`); assigned lazily. */
    code: { type: Number },
    receiptHeader: { type: String },
    receiptFooter: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: cleanJson() },
);
branchSchema.index({ shopId: 1, name: 1 });
branchSchema.plugin(tenantGuard);
export type BranchDoc = HydratedDocument<InferSchemaType<typeof branchSchema>>;
export const Branch = mongoose.model('Branch', branchSchema);

/* ------------------------------------------------------------------------ terminals */

const printerProfileSchema = new Schema(
  {
    connection: { type: String, enum: ['usb', 'serial', 'network'], default: 'usb' },
    printerName: { type: String },
    host: { type: String },
    port: { type: Number, default: 9100 },
    paperWidthMm: { type: Number, default: 58 },
    printWidthDots: { type: Number, default: 384 },
    charsPerLine: { type: Number, default: 32 },
    codePage: { type: String, default: 'CP866' },
    cutEnabled: { type: Boolean, default: false },
    drawerEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const terminalSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
    agentTokenHash: { type: String, index: true },
    /** Encrypted secret shared with the paired agent; signs the short-lived POS session keys. */
    agentSecretEncrypted: { type: String },
    agentMachineId: { type: String },
    agentVersion: { type: String },
    lastSeenAt: { type: Date },
    pairingCodeHash: { type: String, index: true },
    pairingExpiresAt: { type: Date },
    printerProfile: { type: printerProfileSchema, default: () => ({}) },
    deviceStatus: { type: Schema.Types.Mixed },
    /** Offline receipts queued on this till (reported by the POS). */
    pendingOffline: { type: Number, default: 0 },
    posOnlineAt: { type: Date },
    fiscal: {
      provider: { type: String },
      moduleId: { type: String },
      credentialsEncrypted: { type: String },
    },
  },
  { timestamps: true, toJSON: cleanJson(['agentTokenHash', 'agentSecretEncrypted', 'pairingCodeHash', 'fiscal.credentialsEncrypted']) },
);
terminalSchema.index({ shopId: 1, branchId: 1 });
terminalSchema.plugin(tenantGuard);
export type TerminalDoc = HydratedDocument<InferSchemaType<typeof terminalSchema>>;
export const Terminal = mongoose.model('Terminal', terminalSchema);

/* ------------------------------------------------------------------------ audit log */

const auditLogSchema = new Schema(
  {
    /** null = platform-level entry (visible to the superadmin only). */
    shopId: { type: oid, default: null },
    userId: { type: oid, ref: 'User' },
    userName: { type: String },
    role: { type: String },
    action: { type: String, required: true },
    entity: { type: String },
    entityId: { type: String },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
    impersonatedBy: { type: oid },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: cleanJson() },
);
auditLogSchema.index({ shopId: 1, createdAt: -1 });
auditLogSchema.index({ shopId: 1, action: 1, createdAt: -1 });
auditLogSchema.plugin(tenantGuard);
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

/* -------------------------------------------------------------------------- counters */

const counterSchema = new Schema({
  shopId: { type: oid, required: true },
  key: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
counterSchema.index({ shopId: 1, key: 1 }, { unique: true });
counterSchema.plugin(tenantGuard);
export const Counter = mongoose.model('Counter', counterSchema);

/* ------------------------------------------------------------------ platform settings */

const platformSettingsSchema = new Schema(
  {
    key: { type: String, default: 'platform', unique: true },
    defaultLimits: { type: limitsSchema, default: () => DEFAULT_PLATFORM_SETTINGS.defaultLimits },
    graceDays: { type: Number, default: DEFAULT_PLATFORM_SETTINGS.graceDays },
    platformName: { type: String, default: DEFAULT_PLATFORM_SETTINGS.platformName },
    logoUrl: { type: String, default: '' },
    agentInstaller: {
      url: { type: String, default: '' },
      version: { type: String, default: DEFAULT_PLATFORM_SETTINGS.agentInstaller.version },
    },
    longShiftHours: { type: Number, default: DEFAULT_PLATFORM_SETTINGS.longShiftHours },
    nextShopCode: { type: Number, default: 1 },
  },
  { timestamps: true, toJSON: cleanJson(['key']) },
);
export const PlatformSettings = mongoose.model('PlatformSettings', platformSettingsSchema);

/* ----------------------------------------------------------------------- rate limits */

const rateLimitSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RateLimit = mongoose.model('RateLimit', rateLimitSchema);
