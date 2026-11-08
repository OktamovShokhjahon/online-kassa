import { randomUUID } from 'node:crypto';
import { P, api, bearer, login } from './helpers';
import { setup } from './shopCtx';

export const COLA = { price: 1_200_000, cost: 700_000 };
export const BREAD = { price: 300_000, cost: 150_000 };

/**
 * A shop ready to sell: terminal, cashier (PIN 1234), branch manager (PIN 9999), two priced
 * products with 100 units of stock each, and an open shift for the cashier.
 */
export async function posCtx(opts: { shop?: Record<string, unknown>; cashierPerms?: string[]; openShift?: boolean; sa?: { token: string } } = {}) {
  const t = await setup(opts.shop, opts.sa);
  const term = (await t.post('/terminals', { name: 'Kassa 1', branchId: t.shop.branchId })).body.data;
  const cashier = await t.staff('cashier', { pin: '1234', permissions: opts.cashierPerms ?? [] });
  const manager = await t.staff('branch_manager', { pin: '9999' });
  const sup = await t.supplier();
  const cola = await t.product({ name: 'Cola 1L', mxikCode: '12345678901234567', packageCode: '1500', vatRate: 12 });
  const bread = await t.product({ name: 'Bread', mxikCode: '12345678901234568', packageCode: '1501' });
  await t.receive(t.shop.branchId, sup.id, [[cola.id, 100, COLA.cost], [bread.id, 100, BREAD.cost]]);
  await t.put('/prices', { changes: [{ productId: cola.id, branchId: t.shop.branchId, price: COLA.price }, { productId: bread.id, branchId: t.shop.branchId, price: BREAD.price }] });

  let shiftId = '';
  if (opts.openShift !== false) {
    const s = await t.post('/shifts/open', { terminalId: term.id, openingCash: 100_000 }, cashier.h);
    if (s.status !== 201) throw new Error(`open shift ${s.status} ${JSON.stringify(s.body)}`);
    shiftId = s.body.data.id;
  }

  const body = (lines: Array<{ productId: string; qty: number } & Record<string, unknown>>, payments: Array<{ method: string; amount: number }>, extra: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    terminalId: term.id,
    shiftId,
    lines,
    payments,
    ...extra,
  });
  const sell = (lines: any[], payments: any[], extra: Record<string, unknown> = {}, h = cashier.h) => t.post('/sales', body(lines, payments, extra), h);

  return { ...t, term, cashier, manager, cola, bread, supplierId: sup.id, shiftId, body, sell, bearer, login, api, P };
}
