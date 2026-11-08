import { EventEmitter } from 'node:events';
import type { Types } from 'mongoose';
import { logger } from './logger';

/**
 * In-process domain event bus. Business code emits events AFTER the database transaction has
 * committed; subscribers (webhooks, Telegram notifications, live dashboards) react to them.
 */
export interface DomainEvent {
  name:
    | 'sale.created'
    | 'sale.refunded'
    | 'stock.low'
    | 'stock.negative'
    | 'shift.closed'
    | 'shift.long_open'
    | 'goods_receipt.posted'
    | 'price.changed'
    | 'debt.overdue'
    | 'shop.expiring'
    | 'shop.expired'
    | 'server.error';
  shopId: Types.ObjectId | string;
  data: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const events = {
  on(handler: (e: DomainEvent) => void | Promise<void>) {
    emitter.on('event', (e: DomainEvent) => {
      Promise.resolve(handler(e)).catch((err) => logger.error('event handler failed', { event: e.name, err: String(err) }));
    });
  },
  emit(e: DomainEvent) {
    emitter.emit('event', e);
  },
  emitAll(list: DomainEvent[]) {
    list.forEach((e) => emitter.emit('event', e));
  },
  clear() {
    emitter.removeAllListeners('event');
  },
};
