import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PromotionDef } from '@kass/shared';
import type { Cart } from './cart';

/** Local copy of a branch's catalog and the offline queue, kept in IndexedDB (spec 7.6). */
export interface CatalogProduct {
  id: string; name: string; sku?: string; barcodes: string[]; unit: string; isWeighted: boolean; isMarked: boolean; vatRate?: number | null;
  mxikCode?: string | null; packageCode?: string | null; categoryId: string | null; categoryIds: string[]; imageUrl?: string; isActive: boolean;
}
export interface CatalogCustomer { id: string; fullName: string; phone: string; cardBarcode?: string; bonusBalance: number; debtBalance: number; creditLimit?: number | null }
export interface CatalogCategory { id: string; name: string; parentId: string | null; isActive: boolean; sortOrder: number }

export interface QueuedSale {
  clientRequestId: string;
  terminalId: string;
  shiftId: string;
  localNumber: string;
  createdAt: string;
  payload: Record<string, unknown>;
  /** The structured receipt that was printed, so a reprint after sync still works. */
  receipt?: unknown;
  status: 'pending' | 'failed';
  attempts: number;
  error?: { code: string; message: string };
  total: number;
}

export interface HeldCart { id: string; at: string; cart: Cart; label: string }

interface Schema extends DBSchema {
  meta: { key: string; value: unknown };
  products: { key: string; value: CatalogProduct; indexes: { barcode: string; name: string } };
  prices: { key: string; value: { productId: string; price: number } };
  categories: { key: string; value: CatalogCategory };
  customers: { key: string; value: CatalogCustomer; indexes: { phone: string; card: string } };
  queue: { key: string; value: QueuedSale; indexes: { status: string } };
  held: { key: string; value: HeldCart };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
export function resetDbHandle() { dbp = null; }

export function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>('online-kass-pos', 1, {
    upgrade(d) {
      d.createObjectStore('meta');
      const p = d.createObjectStore('products', { keyPath: 'id' });
      p.createIndex('barcode', 'barcodes', { multiEntry: true });
      p.createIndex('name', 'name');
      d.createObjectStore('prices', { keyPath: 'productId' });
      d.createObjectStore('categories', { keyPath: 'id' });
      const c = d.createObjectStore('customers', { keyPath: 'id' });
      c.createIndex('phone', 'phone');
      c.createIndex('card', 'cardBarcode');
      const q = d.createObjectStore('queue', { keyPath: 'clientRequestId' });
      q.createIndex('status', 'status');
      d.createObjectStore('held', { keyPath: 'id' });
    },
  });
  return dbp;
}

export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown) {
  await (await db()).put('meta', value, key);
}

export interface CatalogPayload {
  serverTime: string;
  full: boolean;
  shop: any;
  branch: any;
  categories: CatalogCategory[];
  products: CatalogProduct[];
  prices: Array<{ productId: string; price: number }>;
  removedPriceProductIds: string[];
  promotions: PromotionDef[];
  customers: CatalogCustomer[];
}

/** Applies a full or incremental catalog feed in one transaction. */
export async function applyCatalog(c: CatalogPayload) {
  const d = await db();
  const tx = d.transaction(['meta', 'products', 'prices', 'categories', 'customers'], 'readwrite');
  if (c.full) await Promise.all([tx.objectStore('products').clear(), tx.objectStore('prices').clear(), tx.objectStore('customers').clear()]);
  await tx.objectStore('categories').clear();
  await Promise.all([
    ...c.products.map((p) => tx.objectStore('products').put(p)),
    ...c.prices.map((p) => tx.objectStore('prices').put(p)),
    ...c.removedPriceProductIds.map((id) => tx.objectStore('prices').delete(id)),
    ...c.categories.map((x) => tx.objectStore('categories').put(x)),
    ...c.customers.map((x) => tx.objectStore('customers').put(x)),
    tx.objectStore('meta').put(c.serverTime, 'serverTime'),
    tx.objectStore('meta').put(c.shop, 'shop'),
    tx.objectStore('meta').put(c.branch, 'branch'),
    tx.objectStore('meta').put(c.promotions, 'promotions'),
  ]);
  await tx.done;
}

export async function findByBarcode(code: string): Promise<CatalogProduct | undefined> {
  return (await db()).getFromIndex('products', 'barcode', code);
}
export async function getPrice(productId: string): Promise<number | undefined> {
  return (await (await db()).get('prices', productId))?.price;
}
export async function getProduct(id: string) {
  return (await db()).get('products', id);
}

/** Name / SKU / barcode-prefix search over the local catalog (works offline, fast enough for 50k products). */
export async function searchProducts(q: string, limit = 30): Promise<CatalogProduct[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const all = await (await db()).getAll('products');
  const out: CatalogProduct[] = [];
  for (const p of all) {
    if (!p.isActive) continue;
    if (p.name.toLowerCase().includes(needle) || p.sku?.toLowerCase() === needle || p.barcodes.some((b) => b.startsWith(needle))) {
      out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function searchCustomers(q: string, limit = 20): Promise<CatalogCustomer[]> {
  const needle = q.trim().toLowerCase().replace(/[\s()-]/g, '');
  if (!needle) return [];
  const all = await (await db()).getAll('customers');
  return all.filter((c) => c.fullName.toLowerCase().includes(q.trim().toLowerCase()) || c.phone.replace(/\D/g, '').includes(needle.replace(/\D/g, '') || '§') || c.cardBarcode === q.trim()).slice(0, limit);
}

/* ------------------------------------------------------------------- offline queue */

export const enqueueSale = async (s: QueuedSale) => void (await (await db()).put('queue', s));
export const listQueue = async () => (await (await db()).getAll('queue')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
export const removeQueued = async (id: string) => void (await (await db()).delete('queue', id));
export const updateQueued = async (s: QueuedSale) => void (await (await db()).put('queue', s));
export const queueCount = async () => (await db()).count('queue');

/* ----------------------------------------------------------------------- held carts */

export const holdCart = async (h: HeldCart) => void (await (await db()).put('held', h));
export const listHeld = async () => (await (await db()).getAll('held')).sort((a, b) => a.at.localeCompare(b.at));
export const dropHeld = async (id: string) => void (await (await db()).delete('held', id));

/** Local receipt numbers for offline sales: `L-<terminal>-<n>`. */
export async function nextLocalNumber(terminalId: string): Promise<string> {
  const d = await db();
  const key = `localSeq:${terminalId}`;
  const n = (((await d.get('meta', key)) as number) ?? 0) + 1;
  await d.put('meta', n, key);
  return `L-${terminalId.slice(-4).toUpperCase()}-${String(n).padStart(5, '0')}`;
}
