import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { PAYMENT_METHODS, STOCK_MOVEMENT_TYPES, WRITE_OFF_REASONS } from '@kass/shared';
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

/* --------------------------------------------------------------------- suppliers */

const supplierSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    contactPerson: String,
    phone: String,
    address: String,
    tin: String,
    paymentTermDays: { type: Number, default: 0 },
    note: String,
    /** What the shop owes the supplier: purchases - payments - returns (minor units). */
    balance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: json },
);
supplierSchema.index({ shopId: 1, name: 1 });
supplierSchema.plugin(tenantGuard);
export type SupplierDoc = HydratedDocument<InferSchemaType<typeof supplierSchema>>;
export const Supplier = mongoose.model('Supplier', supplierSchema);

const supplierPaymentSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    supplierId: { type: oid, ref: 'Supplier', required: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    paidAt: { type: Date, required: true },
    comment: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
supplierPaymentSchema.index({ shopId: 1, supplierId: 1, paidAt: -1 });
supplierPaymentSchema.plugin(tenantGuard);
export const SupplierPayment = mongoose.model('SupplierPayment', supplierPaymentSchema);

/* ------------------------------------------------------------------ stock + ledger */

const stockSchema = new Schema({
  shopId: { type: oid, ref: 'Shop', required: true },
  branchId: { type: oid, ref: 'Branch', required: true },
  productId: { type: oid, ref: 'Product', required: true },
  /** May be negative when the shop allows selling without stock. */
  quantity: { type: Number, default: 0 },
  /** Weighted average cost per unit, minor units. */
  avgCost: { type: Number, default: 0 },
  minStock: { type: Number, default: 0 },
});
stockSchema.index({ shopId: 1, branchId: 1, productId: 1 }, { unique: true });
stockSchema.index({ shopId: 1, productId: 1 });
stockSchema.index({ shopId: 1, branchId: 1, quantity: 1 });
stockSchema.plugin(tenantGuard);
export const Stock = mongoose.model('Stock', stockSchema);

const stockMovementSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    productId: { type: oid, ref: 'Product', required: true },
    type: { type: String, enum: STOCK_MOVEMENT_TYPES, required: true },
    /** Signed: + increases stock, - decreases it. */
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    balanceAfter: { type: Number, required: true },
    docType: String,
    docId: { type: oid },
    docNumber: String,
    userId: { type: oid, ref: 'User' },
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, toJSON: json },
);
stockMovementSchema.index({ shopId: 1, productId: 1, createdAt: 1 });
stockMovementSchema.index({ shopId: 1, branchId: 1, createdAt: 1 });
stockMovementSchema.index({ shopId: 1, docType: 1, docId: 1 });
stockMovementSchema.plugin(tenantGuard);
export const StockMovement = mongoose.model('StockMovement', stockMovementSchema);

/* ------------------------------------------------------------------- documents */

const docLine = { productId: { type: oid, ref: 'Product', required: true }, qty: { type: Number, required: true }, cost: { type: Number, default: 0 } };

const goodsReceiptSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    number: { type: String, required: true },
    supplierId: { type: oid, ref: 'Supplier', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    invoiceNo: String,
    invoiceDate: Date,
    lines: { type: [new Schema(docLine, { _id: false })], default: [] },
    total: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    postedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    note: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
goodsReceiptSchema.index({ shopId: 1, number: 1 }, { unique: true });
goodsReceiptSchema.index({ shopId: 1, branchId: 1, createdAt: -1 });
goodsReceiptSchema.index({ shopId: 1, supplierId: 1, createdAt: -1 });
goodsReceiptSchema.plugin(tenantGuard);
export type GoodsReceiptDoc = HydratedDocument<InferSchemaType<typeof goodsReceiptSchema>>;
export const GoodsReceipt = mongoose.model('GoodsReceipt', goodsReceiptSchema);

const supplierReturnSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    number: { type: String, required: true },
    supplierId: { type: oid, ref: 'Supplier', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    goodsReceiptId: { type: oid, ref: 'GoodsReceipt' },
    lines: { type: [new Schema(docLine, { _id: false })], default: [] },
    total: { type: Number, default: 0 },
    reason: { type: String, required: true },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    postedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
supplierReturnSchema.index({ shopId: 1, number: 1 }, { unique: true });
supplierReturnSchema.index({ shopId: 1, supplierId: 1, createdAt: -1 });
supplierReturnSchema.plugin(tenantGuard);
export type SupplierReturnDoc = HydratedDocument<InferSchemaType<typeof supplierReturnSchema>>;
export const SupplierReturn = mongoose.model('SupplierReturn', supplierReturnSchema);

const transferSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    number: { type: String, required: true },
    fromBranchId: { type: oid, ref: 'Branch', required: true },
    toBranchId: { type: oid, ref: 'Branch', required: true },
    lines: {
      type: [
        new Schema(
          {
            productId: { type: oid, ref: 'Product', required: true },
            qtySent: { type: Number, required: true },
            qtyReceived: { type: Number, default: null },
            /** Source average cost at the moment of sending; becomes the incoming cost. */
            unitCost: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: ['draft', 'sent', 'received', 'cancelled'], default: 'draft' },
    sentAt: Date,
    receivedAt: Date,
    discrepancy: { type: Boolean, default: false },
    receiveNote: String,
    note: String,
    cancelReason: String,
    createdBy: { type: oid, ref: 'User' },
    receivedBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
transferSchema.index({ shopId: 1, number: 1 }, { unique: true });
transferSchema.index({ shopId: 1, fromBranchId: 1, createdAt: -1 });
transferSchema.index({ shopId: 1, toBranchId: 1, createdAt: -1 });
transferSchema.plugin(tenantGuard);
export type TransferDoc = HydratedDocument<InferSchemaType<typeof transferSchema>>;
export const Transfer = mongoose.model('Transfer', transferSchema);

const writeOffSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    number: { type: String, required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    reason: { type: String, enum: WRITE_OFF_REASONS, required: true },
    comment: String,
    lines: { type: [new Schema(docLine, { _id: false })], default: [] },
    total: { type: Number, default: 0 },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    postedAt: Date,
    cancelledAt: Date,
    cancelReason: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
writeOffSchema.index({ shopId: 1, number: 1 }, { unique: true });
writeOffSchema.index({ shopId: 1, branchId: 1, createdAt: -1 });
writeOffSchema.plugin(tenantGuard);
export type WriteOffDoc = HydratedDocument<InferSchemaType<typeof writeOffSchema>>;
export const WriteOff = mongoose.model('WriteOff', writeOffSchema);

const stockCountSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    number: { type: String, required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    categoryId: { type: oid, ref: 'Category' },
    lines: {
      type: [
        new Schema(
          {
            productId: { type: oid, ref: 'Product', required: true },
            /** Filled when the count is posted (stock at that moment). */
            expected: { type: Number, default: null },
            counted: { type: Number, default: null },
            diff: { type: Number, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    postedAt: Date,
    note: String,
    createdBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
stockCountSchema.index({ shopId: 1, number: 1 }, { unique: true });
stockCountSchema.index({ shopId: 1, branchId: 1, createdAt: -1 });
stockCountSchema.plugin(tenantGuard);
export type StockCountDoc = HydratedDocument<InferSchemaType<typeof stockCountSchema>>;
export const StockCount = mongoose.model('StockCount', stockCountSchema);
