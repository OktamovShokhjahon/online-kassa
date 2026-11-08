import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyCatalog, db, dropHeld, enqueueSale, findByBarcode, getMeta, getPrice, holdCart, listHeld, listQueue, nextLocalNumber, queueCount, removeQueued, searchCustomers, searchProducts, updateQueued, type CatalogPayload } from '../src/lib/pos/db';
import { emptyCart } from '../src/lib/pos/cart';

const prod = (id: string, name: string, barcodes: string[], extra = {}) => ({ id, name, barcodes, unit: 'piece', isWeighted: false, isMarked: false, categoryId: null, categoryIds: [], isActive: true, ...extra });
const feed = (over: Partial<CatalogPayload> = {}): CatalogPayload => ({
  serverTime: '2026-11-07T10:00:00.000Z', full: true, shop: { name: 'Shop' }, branch: { id: 'b1', name: 'Main' }, categories: [],
  products: [prod('p1', 'Coca-Cola 1L', ['4006381333931', 'COLA-1'], { sku: 'CC1' }), prod('p2', 'Bread', ['4600000000024']), prod('p3', 'Hidden', ['999'], { isActive: false })],
  prices: [{ productId: 'p1', price: 1_200_000 }, { productId: 'p2', price: 300_000 }], removedPriceProductIds: [], promotions: [],
  customers: [{ id: 'c1', fullName: 'Aziz Karimov', phone: '+998915551122', cardBarcode: 'LOY-1', bonusBalance: 5000, debtBalance: 0 }], ...over,
});

beforeEach(async () => {
  const d = await db();
  for (const s of ['meta', 'products', 'prices', 'categories', 'customers', 'queue', 'held'] as const) await d.clear(s);
});

describe('offline catalog (spec 7.6)', () => {
  it('stores the branch catalog and answers barcode lookups, prices and searches locally', async () => {
    await applyCatalog(feed());
    expect((await findByBarcode('4006381333931'))?.name).toBe('Coca-Cola 1L');
    expect((await findByBarcode('COLA-1'))?.id).toBe('p1'); // several barcodes per product
    expect(await findByBarcode('0000')).toBeUndefined();
    expect(await getPrice('p1')).toBe(1_200_000);
    expect(await getPrice('p3')).toBeUndefined(); // no price -> cannot be sold
    expect((await searchProducts('cola')).map((p) => p.id)).toEqual(['p1']);
    expect((await searchProducts('cc1')).map((p) => p.id)).toEqual(['p1']);
    expect((await searchProducts('46000')).map((p) => p.id)).toEqual(['p2']);
    expect(await searchProducts('hidden')).toEqual([]); // inactive products are hidden from the POS
    expect((await searchCustomers('aziz'))[0].id).toBe('c1');
    expect((await searchCustomers('555 11 22'))[0].id).toBe('c1');
    expect((await searchCustomers('LOY-1'))[0].id).toBe('c1');
    expect(await getMeta('serverTime')).toBe('2026-11-07T10:00:00.000Z');
  });

  it('applies incremental updates: changed prices, removed prices, deactivated products', async () => {
    await applyCatalog(feed());
    await applyCatalog(feed({ full: false, serverTime: '2026-11-07T11:00:00.000Z', products: [prod('p2', 'Bread', ['4600000000024'], { isActive: false })], prices: [{ productId: 'p1', price: 1_300_000 }], removedPriceProductIds: ['p2'], customers: [] }));
    expect(await getPrice('p1')).toBe(1_300_000);
    expect(await getPrice('p2')).toBeUndefined();
    expect((await findByBarcode('4600000000024'))?.isActive).toBe(false);
    expect((await findByBarcode('4006381333931'))?.name).toBe('Coca-Cola 1L'); // untouched
    expect((await searchCustomers('aziz')).length).toBe(1);
  });

  it('a full refresh replaces everything', async () => {
    await applyCatalog(feed());
    await applyCatalog(feed({ products: [prod('p9', 'New', ['111'])], prices: [{ productId: 'p9', price: 1 }], customers: [] }));
    expect(await findByBarcode('4006381333931')).toBeUndefined();
    expect(await getPrice('p1')).toBeUndefined();
    expect(await searchCustomers('aziz')).toEqual([]);
  });
});

describe('offline queue and held receipts', () => {
  const sale = (id: string, at: string) => ({ clientRequestId: id, terminalId: 't1', shiftId: 's1', localNumber: 'L-1', createdAt: at, payload: {}, status: 'pending' as const, attempts: 0, total: 100 });
  it('keeps queued sales in the order they were made and survives a reopen', async () => {
    await enqueueSale(sale('b', '2026-11-07T10:02:00Z'));
    await enqueueSale(sale('a', '2026-11-07T10:01:00Z'));
    expect((await listQueue()).map((s) => s.clientRequestId)).toEqual(['a', 'b']);
    expect(await queueCount()).toBe(2);
    await updateQueued({ ...(await listQueue())[0], status: 'failed', error: { code: 'NO_PRICE', message: 'x' } });
    expect((await listQueue())[0].status).toBe('failed');
    await removeQueued('a');
    expect(await queueCount()).toBe(1);
    // the same clientRequestId is idempotent locally too
    await enqueueSale(sale('b', '2026-11-07T10:02:00Z'));
    expect(await queueCount()).toBe(1);
  });
  it('parks and restores receipts, and numbers offline receipts per terminal', async () => {
    await holdCart({ id: 'h1', at: '2026-11-07T10:00:00Z', cart: emptyCart(), label: 'Customer A' });
    await holdCart({ id: 'h2', at: '2026-11-07T10:05:00Z', cart: emptyCart(), label: 'Customer B' });
    expect((await listHeld()).map((h) => h.id)).toEqual(['h1', 'h2']);
    await dropHeld('h1');
    expect((await listHeld()).map((h) => h.id)).toEqual(['h2']);
    expect(await nextLocalNumber('64b0000000000000000000a1')).toBe('L-00A1-00001');
    expect(await nextLocalNumber('64b0000000000000000000a1')).toBe('L-00A1-00002');
    expect(await nextLocalNumber('64b0000000000000000000b2')).toBe('L-00B2-00001');
  });
});
