import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { PROMOTION_TYPES, SALE_PAYMENT_METHODS } from '@kass/shared';
import { tenantGuard } from '../db/tenantGuard';

const oid = Schema.Types.ObjectId;
const json = {
  versionKey: false,
  transform(_d: unknown, ret: Record<string, unknown>) {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
};

/* ------------------------------------------------------------------------ customers */

const customerSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    cardBarcode: String,
    birthday: Date,
    note: String,
    /** Loyalty points in minor units of the shop currency. */
    bonusBalance: { type: Number, default: 0 },
    /** What the customer owes the shop (sales on credit), minor units. */
    debtBalance: { type: Number, default: 0 },
    creditLimit: { type: Number, default: null },
    totalSpent: { type: Number, default: 0 },
    receiptCount: { type: Number, default: 0 },
    lastVisitAt: Date,
    /** When the oldest unpaid credit started (debt ageing). */
    debtSince: Date,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: json },
);
customerSchema.index({ shopId: 1, phone: 1 }, { unique: true });
customerSchema.index({ shopId: 1, cardBarcode: 1 }, { unique: true, partialFilterExpression: { cardBarcode: { $type: 'string' } } });
customerSchema.index({ shopId: 1, fullName: 1 });
customerSchema.plugin(tenantGuard);
export type CustomerDoc = HydratedDocument<InferSchemaType<typeof customerSchema>>;
export const Customer = mongoose.model('Customer', customerSchema);

const bonusTransactionSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    customerId: { type: oid, ref: 'Customer', required: true },
    saleId: oid,
    refundId: oid,
    type: { type: String, enum: ['earn', 'spend', 'earn_reversal', 'spend_reversal'], required: true },
    /** Signed change of the balance. */
    amount: { type: Number, required: true },
    balanceAfter: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: json },
);
bonusTransactionSchema.index({ shopId: 1, customerId: 1, createdAt: -1 });
bonusTransactionSchema.index({ shopId: 1, createdAt: -1 });
bonusTransactionSchema.plugin(tenantGuard);
export const BonusTransaction = mongoose.model('BonusTransaction', bonusTransactionSchema);

const customerPaymentSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    customerId: { type: oid, ref: 'Customer', required: true },
    shiftId: oid,
    branchId: oid,
    amount: { type: Number, required: true },
    method: { type: String, enum: ['cash', 'card'], required: true },
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
customerPaymentSchema.index({ shopId: 1, customerId: 1, createdAt: -1 });
customerPaymentSchema.index({ shopId: 1, shiftId: 1 });
customerPaymentSchema.plugin(tenantGuard);
export const CustomerPayment = mongoose.model('CustomerPayment', customerPaymentSchema);

/* ----------------------------------------------------------------------- promotions */

const promotionSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PROMOTION_TYPES, required: true },
    priority: { type: Number, default: 0 },
    allowStack: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    startsAt: Date,
    endsAt: Date,
    branchIds: { type: [oid], default: [] },
    schedule: { type: Schema.Types.Mixed, default: null },
    rules: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, toJSON: json, minimize: false },
);
promotionSchema.index({ shopId: 1, isActive: 1 });
promotionSchema.plugin(tenantGuard);
export type PromotionDoc = HydratedDocument<InferSchemaType<typeof promotionSchema>>;
export const Promotion = mongoose.model('Promotion', promotionSchema);

/* ------------------------------------------------------------------- shifts & cash */

const shiftSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    terminalId: { type: oid, ref: 'Terminal', required: true },
    cashierId: { type: oid, ref: 'User', required: true },
    cashierName: String,
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    openedAt: { type: Date, default: Date.now },
    openingCash: { type: Number, default: 0 },
    closedAt: Date,
    closedBy: { type: oid, ref: 'User' },
    countedCash: Number,
    expectedCash: Number,
    difference: Number,
    /** Totals frozen at closing (the Z-report). */
    totals: { type: Schema.Types.Mixed },
    fiscalShiftId: String,
    note: String,
    longOpenNotifiedAt: Date,
    /** Opened and closed by the cash-desk program itself (one shift per day, no cashier action). */
    autoManaged: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON: json, minimize: false },
);
// One open shift per terminal.
shiftSchema.index({ shopId: 1, terminalId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
shiftSchema.index({ shopId: 1, branchId: 1, openedAt: -1 });
shiftSchema.index({ shopId: 1, cashierId: 1, openedAt: -1 });
shiftSchema.plugin(tenantGuard);
export type ShiftDoc = HydratedDocument<InferSchemaType<typeof shiftSchema>>;
export const Shift = mongoose.model('Shift', shiftSchema);

const cashOperationSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    shiftId: { type: oid, ref: 'Shift', required: true },
    type: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: Number, required: true },
    comment: String,
    userId: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
cashOperationSchema.index({ shopId: 1, shiftId: 1, createdAt: 1 });
cashOperationSchema.plugin(tenantGuard);
export const CashOperation = mongoose.model('CashOperation', cashOperationSchema);

/* ---------------------------------------------------------------------------- sales */

const saleLineSchema = new Schema(
  {
    productId: { type: oid, ref: 'Product', required: true },
    name: String,
    barcode: String,
    markingCode: String,
    unit: String,
    qty: { type: Number, required: true },
    /** Unit price before discounts. */
    price: { type: Number, required: true },
    promotionId: oid,
    promotionName: String,
    promoDiscount: { type: Number, default: 0 },
    manualDiscount: { type: Number, default: 0 },
    /** This line's share of the receipt-level manual discount. */
    receiptDiscountShare: { type: Number, default: 0 },
    /** Final amount of the line after every discount. */
    total: { type: Number, required: true },
    /** Branch average cost at the moment of sale (gross profit reports). */
    unitCost: { type: Number, default: 0 },
    negativeStock: { type: Boolean, default: false },
    vatRate: Number,
    mxikCode: String,
    packageCode: String,
    refundedQty: { type: Number, default: 0 },
    refundedAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

const saleSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    terminalId: { type: oid, ref: 'Terminal', required: true },
    shiftId: { type: oid, ref: 'Shift', required: true },
    cashierId: { type: oid, ref: 'User', required: true },
    cashierName: String,
    customerId: { type: oid, ref: 'Customer' },
    number: { type: String, required: true },
    localNumber: String,
    lines: { type: [saleLineSchema], default: [] },
    /** Sum of qty * price before any discount. */
    subtotal: { type: Number, required: true },
    /** All discounts together (promotions + manual + receipt-level). */
    discount: { type: Number, default: 0 },
    receiptDiscount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    /** Amounts applied to the receipt per method (cash is net of change). */
    payments: { type: [new Schema({ method: { type: String, enum: SALE_PAYMENT_METHODS }, amount: Number }, { _id: false })], default: [] },
    cashGiven: { type: Number, default: 0 },
    change: { type: Number, default: 0 },
    bonusEarned: { type: Number, default: 0 },
    bonusSpent: { type: Number, default: 0 },
    currency: String,
    fiscal: {
      status: { type: String },
      sign: String,
      receiptId: String,
      qr: String,
      moduleId: String,
    },
    isOffline: { type: Boolean, default: false },
    syncedAt: Date,
    /** Offline sync: differences between what was charged and the server's current data. */
    conflicts: { type: [Schema.Types.Mixed], default: [] },
    clientRequestId: { type: String, required: true },
    status: { type: String, enum: ['completed', 'partially_refunded', 'refunded'], default: 'completed' },
    refundedTotal: { type: Number, default: 0 },
    approvedBy: { type: oid, ref: 'User' },
    /** Offline sales keep the time they were actually made. */
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: false, updatedAt: true }, toJSON: json, minimize: false },
);
saleSchema.index({ shopId: 1, createdAt: -1 });
saleSchema.index({ shopId: 1, branchId: 1, createdAt: -1 });
saleSchema.index({ shopId: 1, shiftId: 1 });
saleSchema.index({ shopId: 1, number: 1 }, { unique: true });
saleSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true });
saleSchema.index({ shopId: 1, cashierId: 1, createdAt: -1 });
saleSchema.index({ shopId: 1, customerId: 1, createdAt: -1 });
saleSchema.index({ shopId: 1, 'lines.productId': 1, createdAt: -1 });
saleSchema.plugin(tenantGuard);
export type SaleDoc = HydratedDocument<InferSchemaType<typeof saleSchema>>;
export const Sale = mongoose.model('Sale', saleSchema);

const refundSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    saleId: { type: oid, ref: 'Sale', required: true },
    saleNumber: String,
    number: { type: String, required: true },
    branchId: { type: oid, required: true },
    terminalId: oid,
    shiftId: { type: oid, ref: 'Shift', required: true },
    cashierId: { type: oid, ref: 'User' },
    lines: {
      type: [new Schema({ lineIndex: Number, productId: oid, name: String, qty: Number, amount: Number, unitCost: Number }, { _id: false })],
      default: [],
    },
    total: { type: Number, required: true },
    /** Money actually paid out: total minus bonus restored and credit offset. */
    payout: { type: Number, default: 0 },
    method: { type: String, enum: ['cash', 'card', 'debt'], required: true },
    reason: String,
    restock: { type: String, enum: ['stock', 'writeoff'], default: 'stock' },
    approvedBy: { type: oid, ref: 'User' },
    bonusReversed: { type: Number, default: 0 },
    bonusRestored: { type: Number, default: 0 },
    debtReduced: { type: Number, default: 0 },
    clientRequestId: String,
    fiscal: { status: String, sign: String, receiptId: String, qr: String, moduleId: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: json },
);
refundSchema.index({ shopId: 1, createdAt: -1 });
refundSchema.index({ shopId: 1, saleId: 1 });
refundSchema.index({ shopId: 1, shiftId: 1 });
refundSchema.index({ shopId: 1, number: 1 }, { unique: true });
refundSchema.index({ shopId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
refundSchema.plugin(tenantGuard);
export type RefundDoc = HydratedDocument<InferSchemaType<typeof refundSchema>>;
export const Refund = mongoose.model('Refund', refundSchema);

const fiscalLogSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    terminalId: { type: oid, required: true },
    docType: { type: String, enum: ['sale', 'refund', 'open_shift', 'close_shift', 'status'], required: true },
    docId: oid,
    provider: String,
    request: Schema.Types.Mixed,
    response: Schema.Types.Mixed,
    status: { type: String, enum: ['ok', 'error', 'timeout'], required: true },
    error: String,
    durationMs: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: json },
);
fiscalLogSchema.index({ shopId: 1, createdAt: -1 });
fiscalLogSchema.index({ shopId: 1, terminalId: 1, createdAt: -1 });
fiscalLogSchema.plugin(tenantGuard);
export const FiscalLog = mongoose.model('FiscalLog', fiscalLogSchema);

/* ------------------------------------------------------------------- declined sales */

/**
 * A receipt that did not become a sale: cleared by the cashier before payment ("cleared") or
 * refused by the server ("rejected", with the error code). Shown in the history next to the
 * approved sales so the owner sees every attempt at the till.
 */
const declinedSaleSchema = new Schema(
  {
    shopId: { type: oid, required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    terminalId: { type: oid, ref: 'Terminal' },
    shiftId: { type: oid, ref: 'Shift' },
    cashierName: String,
    source: { type: String, enum: ['desk', 'pos'], default: 'desk' },
    reason: { type: String, enum: ['cleared', 'rejected'], required: true },
    errorCode: String,
    lines: {
      type: [new Schema({ productId: oid, name: String, qty: Number, price: Number }, { _id: false })],
      default: [],
    },
    total: { type: Number, default: 0 },
    method: String,
    /** The program's id of the attempt: the same event sent twice is stored once. */
    clientEventId: String,
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false, toJSON: json },
);
declinedSaleSchema.index({ shopId: 1, createdAt: -1 });
declinedSaleSchema.index({ shopId: 1, terminalId: 1, createdAt: -1 });
declinedSaleSchema.index({ shopId: 1, clientEventId: 1 }, { unique: true, partialFilterExpression: { clientEventId: { $type: 'string' } } });
declinedSaleSchema.plugin(tenantGuard);
export const DeclinedSale = mongoose.model('DeclinedSale', declinedSaleSchema);
