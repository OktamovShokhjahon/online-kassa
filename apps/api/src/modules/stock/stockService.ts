import { inventoryEnabled } from '@kass/shared';
import type { ClientSession, Types } from 'mongoose';
import type { StockMovementType } from '@kass/shared';
import { unprocessable } from '../../lib/errors';
import type { DomainEvent } from '../../lib/events';
import { Shop } from '../../models/core';
import { Stock, StockMovement } from '../../models/stock';

export interface MoveInput {
  branchId: Types.ObjectId | string;
  productId: Types.ObjectId | string;
  type: StockMovementType;
  /** Signed: + adds stock, - removes it. */
  quantity: number;
  /**
   * Cost per unit in minor units. For incoming stock it feeds the weighted average cost;
   * when omitted the average is left untouched. For outgoing stock the movement records the
   * current average cost (or this value, when given - e.g. reversals).
   */
  unitCost?: number;
  docType?: string;
  docId?: Types.ObjectId | string;
  docNumber?: string;
  note?: string;
}

export interface MoveResult {
  balanceAfter: number;
  balanceBefore: number;
  avgCost: number;
  negative: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * All stock changes of a business transaction go through one `StockTx` bound to the MongoDB
 * session. Every movement updates the balance atomically (single-document pipeline update), keeps
 * the weighted average cost per branch and appends a row to the movement ledger, so
 * `stock.quantity === sum(movements.quantity)` always holds.
 */
export class StockTx {
  readonly events: DomainEvent[] = [];

  constructor(
    readonly shopId: Types.ObjectId,
    readonly session: ClientSession,
    readonly userId: Types.ObjectId | undefined,
    /** shop.settings.allowNegativeStock */
    readonly allowNegative: boolean,
  ) {}

  static async forShop(shopId: Types.ObjectId, session: ClientSession, userId?: Types.ObjectId) {
    // without the warehouse, quantities are not counted: a sale never fails for lack of stock
    if (!inventoryEnabled()) return new StockTx(shopId, session, userId, true);
    const shop = await Shop.findById(shopId).select('settings.allowNegativeStock').session(session).lean();
    return new StockTx(shopId, session, userId, shop?.settings?.allowNegativeStock !== false);
  }

  async move(m: MoveInput): Promise<MoveResult> {
    const q = round3(m.quantity);
    const filter = { shopId: this.shopId, branchId: m.branchId, productId: m.productId };
    const oldQ = { $ifNull: ['$quantity', 0] };
    const oldA = { $ifNull: ['$avgCost', 0] };
    let after: { quantity: number; avgCost: number; minStock?: number } | null;

    if (q >= 0) {
      const avg =
        m.unitCost === undefined
          ? oldA
          : {
              $cond: [
                { $gt: [oldQ, 0] },
                { $round: [{ $divide: [{ $add: [{ $multiply: [oldQ, oldA] }, q * m.unitCost] }, { $add: [oldQ, q] }] }, 0] },
                m.unitCost,
              ],
            };
      after = await Stock.findOneAndUpdate(
        filter,
        [{ $set: { quantity: { $round: [{ $add: [oldQ, q] }, 3] }, avgCost: avg, minStock: { $ifNull: ['$minStock', 0] } } }],
        { upsert: true, new: true, session: this.session },
      ).lean();
    } else if (this.allowNegative) {
      after = await Stock.findOneAndUpdate(
        filter,
        [{ $set: { quantity: { $round: [{ $add: [oldQ, q] }, 3] }, avgCost: oldA, minStock: { $ifNull: ['$minStock', 0] } } }],
        { upsert: true, new: true, session: this.session },
      ).lean();
    } else {
      // Negative stock is blocked by the shop admin: only decrement when enough is on hand.
      after = await Stock.findOneAndUpdate(
        { ...filter, quantity: { $gte: -q - 1e-9 } },
        [{ $set: { quantity: { $round: [{ $add: [oldQ, q] }, 3] } } }],
        { new: true, session: this.session },
      ).lean();
      if (!after) {
        const have = await Stock.findOne(filter).select('quantity').session(this.session).lean();
        throw unprocessable('INSUFFICIENT_STOCK', undefined, { productId: String(m.productId), available: have?.quantity ?? 0, requested: -q });
      }
    }

    const balanceAfter = after!.quantity;
    const balanceBefore = round3(balanceAfter - q);
    const unitCost = q < 0 ? (m.unitCost ?? after!.avgCost) : (m.unitCost ?? after!.avgCost);
    await StockMovement.create(
      [
        {
          shopId: this.shopId,
          branchId: m.branchId,
          productId: m.productId,
          type: m.type,
          quantity: q,
          unitCost,
          balanceAfter,
          docType: m.docType,
          docId: m.docId,
          docNumber: m.docNumber,
          userId: this.userId,
          note: m.note,
        },
      ],
      { session: this.session },
    );

    // stock alerts (Telegram, webhooks) only when the warehouse is in use
    if (!inventoryEnabled()) return { balanceAfter, balanceBefore, avgCost: after!.avgCost, negative: false };
    const minStock = after!.minStock ?? 0;
    if (minStock > 0 && balanceAfter <= minStock && balanceBefore > minStock) {
      this.events.push({ name: 'stock.low', shopId: this.shopId, data: { branchId: String(m.branchId), productId: String(m.productId), quantity: balanceAfter, minStock } });
    }
    if (balanceAfter < 0 && balanceBefore >= 0) {
      this.events.push({ name: 'stock.negative', shopId: this.shopId, data: { branchId: String(m.branchId), productId: String(m.productId), quantity: balanceAfter } });
    }
    return { balanceAfter, balanceBefore, avgCost: after!.avgCost, negative: balanceAfter < 0 };
  }
}

/**
 * The shop currency is locked after the first posted document or sale (amounts are never
 * converted). Called from every posting flow, inside its transaction.
 */
export async function lockCurrency(shopId: Types.ObjectId, session: ClientSession) {
  await Shop.updateOne({ _id: shopId, currencyLocked: false }, { $set: { currencyLocked: true } }, { session });
}
