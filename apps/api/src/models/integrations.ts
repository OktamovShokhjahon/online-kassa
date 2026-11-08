import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { tenantGuard } from '../db/tenantGuard';

const oid = Schema.Types.ObjectId;
const json = (hidden: string[] = []) => ({
  versionKey: false,
  transform(_d: unknown, ret: Record<string, unknown>) {
    ret.id = String(ret._id);
    delete ret._id;
    hidden.forEach((k) => delete ret[k]);
    return ret;
  },
});

export const API_SCOPES = ['products:read', 'products:write', 'prices:read', 'stock:read', 'sales:read', 'sales:write', 'customers:read', 'reports:read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Integration keys (spec 10.2): the full key is shown once; only its hash is stored. */
const apiKeySchema = new Schema(
  {
    shopId: { type: oid, required: true },
    name: { type: String, required: true, trim: true },
    prefix: { type: String, required: true },
    last4: { type: String, required: true },
    keyHash: { type: String, required: true, index: true },
    scopes: { type: [String], enum: API_SCOPES, default: [] },
    branchId: { type: oid, ref: 'Branch', default: null },
    expiresAt: Date,
    lastUsedAt: Date,
    requestCount: { type: Number, default: 0 },
    revokedAt: Date,
    createdBy: { type: oid, ref: 'User' },
    /**
     * Set on keys that belong to a downloadable program (the cash-desk program): such keys have no
     * public API scopes and can only use the program's own endpoints, for one terminal.
     */
    program: {
      type: new Schema(
        {
          kind: { type: String, enum: ['desk'], required: true },
          terminalId: { type: oid, ref: 'Terminal', required: true },
          cashierId: { type: oid, ref: 'User', required: true },
          settings: { type: Schema.Types.Mixed },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true, toJSON: json(['keyHash']) },
);
apiKeySchema.index({ shopId: 1, createdAt: -1 });
apiKeySchema.plugin(tenantGuard);
export type ApiKeyDoc = HydratedDocument<InferSchemaType<typeof apiKeySchema>>;
export const ApiKey = mongoose.model('ApiKey', apiKeySchema);

export const WEBHOOK_EVENTS = ['sale.created', 'sale.refunded', 'stock.low', 'stock.negative', 'shift.closed', 'goods_receipt.posted', 'price.changed'] as const;

const webhookSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    url: { type: String, required: true },
    /** Signing secret, encrypted at rest; shown to the admin once on creation. */
    secretEncrypted: { type: String, required: true },
    events: { type: [String], enum: WEBHOOK_EVENTS, default: [] },
    isActive: { type: Boolean, default: true },
    description: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json(['secretEncrypted']) },
);
webhookSchema.index({ shopId: 1, isActive: 1 });
webhookSchema.plugin(tenantGuard);
export type WebhookDoc = HydratedDocument<InferSchemaType<typeof webhookSchema>>;
export const Webhook = mongoose.model('Webhook', webhookSchema);

const deliverySchema = new Schema(
  {
    shopId: { type: oid, required: true },
    webhookId: { type: oid, ref: 'Webhook', required: true },
    event: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'sending', 'delivered', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastStatusCode: Number,
    lastError: String,
    deliveredAt: Date,
    /** Retries stop 24 hours after creation. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: json() },
);
deliverySchema.index({ shopId: 1, webhookId: 1, createdAt: -1 });
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
deliverySchema.plugin(tenantGuard);
export type WebhookDeliveryDoc = HydratedDocument<InferSchemaType<typeof deliverySchema>>;
export const WebhookDelivery = mongoose.model('WebhookDelivery', deliverySchema);

/* --------------------------------------------------------------------------- telegram */

const notificationsSchema = new Schema(
  {
    dailySummary: { enabled: { type: Boolean, default: true }, time: { type: String, default: '21:00' } },
    shiftClosed: { type: Boolean, default: true },
    refundAbove: { enabled: { type: Boolean, default: true }, amount: { type: Number, default: 50_000_00 } },
    lowStock: { type: Boolean, default: true },
    negativeStock: { type: Boolean, default: true },
    longShift: { type: Boolean, default: true },
    debtsOverdue: { type: Boolean, default: true },
    subscriptionExpiring: { type: Boolean, default: true },
  },
  { _id: false },
);

const telegramRecipientSchema = new Schema(
  {
    /** null = platform (superadmin) alerts. */
    shopId: { type: oid, default: null },
    userId: { type: oid, ref: 'User', required: true },
    chatId: { type: String, required: true },
    username: String,
    language: { type: String, enum: ['uz', 'ru', 'en'], default: 'uz' },
    notifications: { type: notificationsSchema, default: () => ({}) },
    lastDailySummaryDate: String,
    lastDebtReminderDate: String,
    lastExpiryNoticeDate: String,
  },
  { timestamps: true, toJSON: json() },
);
telegramRecipientSchema.index({ shopId: 1, userId: 1 });
telegramRecipientSchema.index({ chatId: 1 });
telegramRecipientSchema.plugin(tenantGuard);
export type TelegramRecipientDoc = HydratedDocument<InferSchemaType<typeof telegramRecipientSchema>>;
export const TelegramRecipient = mongoose.model('TelegramRecipient', telegramRecipientSchema);

const telegramLinkSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: oid, required: true },
  shopId: { type: oid, default: null },
  expiresAt: { type: Date, required: true },
});
telegramLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TelegramLink = mongoose.model('TelegramLink', telegramLinkSchema);

/* ------------------------------------------------------------------- daily summaries */

const dailySummarySchema = new Schema({
  shopId: { type: oid, required: true },
  branchId: { type: oid, required: true },
  /** Tashkent calendar day, YYYY-MM-DD. */
  date: { type: String, required: true },
  receipts: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 },
  discounts: { type: Number, default: 0 },
  returns: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
  computedAt: { type: Date, default: Date.now },
});
dailySummarySchema.index({ shopId: 1, branchId: 1, date: 1 }, { unique: true });
dailySummarySchema.plugin(tenantGuard);
export const DailySummary = mongoose.model('DailySummary', dailySummarySchema);
