import mongoose, { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { UNITS } from '@kass/shared';
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

/* --------------------------------------------------------------------- categories */

const categorySchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    parentId: { type: oid, ref: 'Category', default: null },
    /** Ancestor ids from the root down to the parent. */
    path: { type: [oid], default: [] },
    /** 1 = root. Trees are limited to 3 levels. */
    depth: { type: Number, default: 1 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: json },
);
categorySchema.index({ shopId: 1, parentId: 1, sortOrder: 1 });
categorySchema.plugin(tenantGuard);
export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = mongoose.model('Category', categorySchema);

/* ------------------------------------------------------------------------ products */

const productSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, trim: true },
    barcodes: { type: [String], default: [] },
    categoryId: { type: oid, ref: 'Category', default: null },
    unit: { type: String, enum: UNITS, default: 'piece' },
    isWeighted: { type: Boolean, default: false },
    vatRate: { type: Number, default: null },
    mxikCode: { type: String, default: null },
    packageCode: { type: String, default: null },
    isMarked: { type: Boolean, default: false },
    /** Cost price per unit (minor units); the cost of a sale when no goods receipts give one. */
    costPrice: { type: Number, default: null },
    /** Deleted from the catalog. Kept only because sales or stock history refer to it. */
    deletedAt: { type: Date, default: null },
    /** Barcodes it had when deleted: freed so a new product can use them. */
    deletedBarcodes: { type: [String], default: undefined },
    imageUrl: { type: String },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: json },
);
// Barcodes and SKUs are unique within a shop. Partial indexes: products without barcodes/SKU
// must not collide with each other (empty arrays would otherwise index as `null`).
productSchema.index(
  { shopId: 1, barcodes: 1 },
  { unique: true, partialFilterExpression: { 'barcodes.0': { $exists: true } } },
);
productSchema.index({ shopId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: 'string' } } });
productSchema.index({ shopId: 1, categoryId: 1, isActive: 1 });
productSchema.index({ shopId: 1, name: 1 });
productSchema.index({ name: 'text' });
productSchema.plugin(tenantGuard);
export type ProductDoc = HydratedDocument<InferSchemaType<typeof productSchema>>;
export const Product = mongoose.model('Product', productSchema);

/* -------------------------------------------------------------------------- prices */

const priceSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    productId: { type: oid, ref: 'Product', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    /** Integer minor units. */
    price: { type: Number, required: true },
    updatedBy: { type: oid, ref: 'User' },
  },
  { timestamps: true, toJSON: json },
);
priceSchema.index({ shopId: 1, productId: 1, branchId: 1 }, { unique: true });
priceSchema.index({ shopId: 1, branchId: 1 });
priceSchema.plugin(tenantGuard);
export const Price = mongoose.model('Price', priceSchema);

const priceChangeSchema = new Schema(
  {
    shopId: { type: oid, ref: 'Shop', required: true },
    productId: { type: oid, ref: 'Product', required: true },
    branchId: { type: oid, ref: 'Branch', required: true },
    oldPrice: { type: Number, default: null },
    newPrice: { type: Number, default: null },
    effectiveAt: { type: Date, required: true },
    status: { type: String, enum: ['applied', 'scheduled', 'applying', 'cancelled'], required: true },
    userId: { type: oid, ref: 'User' },
    source: { type: String, enum: ['manual', 'bulk', 'copy', 'import', 'scheduled', 'branch_copy'], default: 'manual' },
  },
  { timestamps: true, toJSON: json },
);
priceChangeSchema.index({ shopId: 1, productId: 1, branchId: 1, createdAt: -1 });
priceChangeSchema.index({ status: 1, effectiveAt: 1 });
priceChangeSchema.plugin(tenantGuard);
export const PriceChange = mongoose.model('PriceChange', priceChangeSchema);
