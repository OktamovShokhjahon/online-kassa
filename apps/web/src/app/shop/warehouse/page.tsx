'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Icon } from '@/components/icons';
import { ProductSearch, useBranches, useSuppliers } from '@/components/pickers';
import { Badge, Button, Card, Checkbox, DataTable, Empty, Field, FormError, Input, Modal, MoneyInput, PageHeader, Pagination, Select, Skeleton, Stat, Textarea, useToast } from '@/components/ui';
import { api, apiPage, post, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { daysAgo, fmtDate, fmtDateTime, today, useMoney } from '@/lib/format';

type Period = 'today' | '7d' | '30d' | 'month' | 'all';

/** Start of a Tashkent calendar day as an ISO instant. */
const dayStart = (d: string) => new Date(`${d}T00:00:00+05:00`).toISOString();

function periodFrom(p: Period): string | undefined {
  if (p === 'today') return dayStart(today());
  if (p === '7d') return dayStart(daysAgo(6));
  if (p === '30d') return dayStart(daysAgo(29));
  if (p === 'month') return dayStart(today().slice(0, 8) + '01');
  return undefined;
}

const qtyFmt = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('ru-RU');

export default function WarehousePage() {
  const t = useTranslations('shop.warehouse');
  const tc = useTranslations('common');
  const { can } = useAuth();
  const { m } = useMoney();
  const [period, setPeriod] = useState<Period>('30d');
  const [supplierId, setSupplierId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [cancel, setCancel] = useState<any>(null);
  const [allProducts, setAllProducts] = useState(false);
  const { data: suppliers } = useSuppliers();
  const canCreate = can('stock.receipt');

  // /shop/warehouse?supplierId=… (from the suppliers page)
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('supplierId');
    if (s) { setSupplierId(s); setPeriod('all'); }
  }, []);
  useEffect(() => setPage(1), [period, supplierId]);

  const from = periodFrom(period);
  const filter = { from, supplierId: supplierId === 'none' ? undefined : supplierId || undefined };
  const stats = useQuery({ queryKey: ['receipt-stats', filter], queryFn: () => api<any>('/goods-receipts/stats' + qs(filter)) });
  const list = useQuery({ queryKey: ['goods-receipts', page, filter], queryFn: () => apiPage<any>('/goods-receipts' + qs({ page, limit: 15, ...filter })) });
  const supplierName = (id?: string | null) => (id ? suppliers?.find((s) => s.id === id)?.name ?? '…' : t('noSupplier'));

  const s = stats.data;
  const axis = { tickLine: false, axisLine: false, tick: { fontSize: 11, fill: 'rgb(var(--muted))' } } as const;
  const fmtAxis = (v: number) => { const x = Math.abs(v) / 100; return x >= 1e6 ? (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(Math.round(x)); };

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={canCreate && <Button onClick={() => setCreating(true)}><Icon name="warehouse" className="h-4 w-4" />{t('newArrival')}</Button>}
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label={t('period')} className="w-44">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {(['today', '7d', '30d', 'month', 'all'] as const).map((p) => <option key={p} value={p}>{t(`periods.${p}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('supplier')} className="w-60">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{t('allSuppliers')}</option>
            {suppliers?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {s ? <>
          <Stat hero icon="wallet" label={t('totalAmount')} num={s.totals.amount} fmt={m} spark={s.byDay.map((d: any) => d.amount)} />
          <Stat icon="receipts" label={t('arrivals')} num={s.totals.receipts} delay={60} />
          <Stat icon="box" label={t('quantity')} num={s.totals.quantity} fmt={qtyFmt} delay={120} />
          <Stat icon="products" label={t('products')} num={s.totals.products} sub={`${t('suppliersCount')}: ${s.totals.suppliers}`} delay={180} />
        </> : [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card title={t('byDay')} className="xl:col-span-2">
          {s && s.byDay.length > 0 ? (
            <div className="h-60">
              <ResponsiveContainer>
                <BarChart data={s.byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 6" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5).split('-').reverse().join('.')} {...axis} />
                  <YAxis tickFormatter={fmtAxis} width={46} {...axis} />
                  <Tooltip
                    formatter={(v: number) => m(v)}
                    labelFormatter={(d: string) => d.split('-').reverse().join('.')}
                    contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--border))', borderRadius: 12, fontSize: 12, color: 'rgb(var(--fg))' }}
                  />
                  <Bar dataKey="amount" name={t('amount')} fill="rgb(var(--primary))" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <Empty>{t('noArrivals')}</Empty>}
        </Card>
        <Card title={t('byProduct')} actions={s && s.byProduct.length > 10 && <Button size="sm" variant="ghost" onClick={() => setAllProducts(!allProducts)}>{allProducts ? t('showTop') : t('showAll', { n: s.byProduct.length })}</Button>}>
          <DataTable
            rows={(s?.byProduct ?? []).slice(0, allProducts ? undefined : 10)}
            loading={!s}
            rowKey={(r: any) => r.productId}
            columns={[
              { key: 'name', header: tc('name'), render: (r: any) => <div><span className="font-medium">{r.name}</span><div className="text-xs text-muted">{t('lastArrival')}: {fmtDate(r.lastAt)}</div></div> },
              { key: 'quantity', header: t('quantity'), align: 'right', render: (r: any) => qtyFmt(r.quantity) },
              { key: 'avgCost', header: t('avgCost'), align: 'right', render: (r: any) => m(r.avgCost) },
              { key: 'amount', header: t('amount'), align: 'right', render: (r: any) => <b>{m(r.amount)}</b> },
            ]}
          />
        </Card>
        <Card title={t('bySupplier')}>
          <DataTable
            rows={s?.bySupplier ?? []}
            loading={!s}
            rowKey={(r: any) => r.supplierId ?? 'none'}
            columns={[
              { key: 'name', header: t('supplier'), render: (r: any) => (r.supplierId ? <span className="font-medium">{r.name}</span> : <span className="text-muted">{t('noSupplier')}</span>) },
              { key: 'receipts', header: t('arrivals'), align: 'right' },
              { key: 'quantity', header: t('quantity'), align: 'right', render: (r: any) => qtyFmt(r.quantity) },
              { key: 'amount', header: t('amount'), align: 'right', render: (r: any) => <b>{m(r.amount)}</b> },
            ]}
          />
        </Card>
      </div>

      <Card title={t('history')}>
        <DataTable
          rows={list.data?.data ?? []}
          loading={list.isLoading}
          rowKey={(r: any) => r.id}
          columns={[
            { key: 'postedAt', header: tc('date'), render: (r: any) => <div><span>{fmtDateTime(r.postedAt ?? r.createdAt)}</span><div className="text-xs text-muted">{r.number}</div></div> },
            { key: 'lines', header: t('products'), render: (r: any) => <div className="space-y-0.5">{r.lines.slice(0, 3).map((l: any, i: number) => <div key={i} className="text-sm">{l.productName} <span className="text-muted">× {qtyFmt(l.qty)}</span></div>)}{r.lines.length > 3 && <div className="text-xs text-muted">{t('more', { n: r.lines.length - 3 })}</div>}</div> },
            { key: 'supplierId', header: t('supplier'), render: (r: any) => (r.supplierId ? supplierName(r.supplierId) : <span className="text-muted">{t('noSupplier')}</span>) },
            { key: 'total', header: t('amount'), align: 'right', render: (r: any) => <b>{m(r.total)}</b> },
            { key: 'status', header: tc('status'), render: (r: any) => <Badge tone={r.status === 'posted' ? 'success' : r.status === 'cancelled' ? 'danger' : 'neutral'}>{t(`status.${r.status}`)}</Badge> },
            { key: '__a', header: '', align: 'right', render: (r: any) => (canCreate && r.status === 'posted' ? <Button size="sm" variant="ghost" onClick={() => setCancel(r)}>{t('cancel')}</Button> : null) },
          ]}
        />
        {list.data && <Pagination page={page} limit={15} total={list.data.meta?.total ?? 0} onPage={setPage} />}
      </Card>

      <ArrivalModal open={creating} onClose={() => setCreating(false)} />
      <CancelModal doc={cancel} onClose={() => setCancel(null)} />
    </>
  );
}

interface Line { id: string; name: string; unit?: string; qty: string; cost: number | null }

function ArrivalModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('shop.warehouse');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { m } = useMoney();
  const { data: branches } = useBranches();
  const { data: suppliers } = useSuppliers();
  const isOwner = user?.role === 'shop_admin';
  const blank = () => ({ supplierId: '', branchId: '', note: '', updateCostPrice: true, lines: [] as Line[] });
  const [f, setF] = useState(blank);
  useEffect(() => { if (open) setF(blank()); }, [open]);
  const branchId = f.branchId || branches?.[0]?.id || '';

  const addProduct = async (p: { id: string; name: string; unit?: string }) => {
    if (f.lines.some((l) => l.id === p.id)) return;
    let cost: number | null = null;
    try { cost = (await api<any>(`/products/${p.id}`)).costPrice ?? null; } catch { /* no cost price */ }
    setF((x) => ({ ...x, lines: [...x.lines, { id: p.id, name: p.name, unit: p.unit, qty: '1', cost }] }));
  };
  const setLine = (i: number, patch: Partial<Line>) => setF((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const valid = f.lines.length > 0 && f.lines.every((l) => Number(l.qty) > 0) && !!branchId;
  const total = f.lines.reduce((s, l) => s + Math.round((Number(l.qty) || 0) * (l.cost ?? 0)), 0);

  const save = useMutation({
    mutationFn: () => post('/goods-receipts', {
      branchId,
      supplierId: f.supplierId || undefined,
      note: f.note || undefined,
      post: true,
      updateCostPrice: isOwner && f.updateCostPrice,
      lines: f.lines.map((l) => ({ productId: l.id, qty: Number(l.qty), cost: l.cost ?? 0 })),
    }),
    onSuccess: () => {
      for (const k of ['goods-receipts', 'receipt-stats', 'suppliers', 'products']) qc.invalidateQueries({ queryKey: [k] });
      toast.ok(t('saved'));
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={t('newArrival')}
      footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{t('saveArrival')}</Button></>}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('supplier')} hint={<Link href="/shop/suppliers" className="text-primary underline">{t('manageSuppliers')}</Link>}>
          <Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
            <option value="">{t('noSupplier')}</option>
            {suppliers?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {branches && branches.length > 1 && (
          <Field label={t('branch')}>
            <Select value={branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              {branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t('addProduct')} className="md:col-span-2" hint={<>{t('productMustExist')} <Link href="/shop/products" className="text-primary underline">{t('toProducts')}</Link></>}>
          <ProductSearch onPick={addProduct} placeholder={t('searchProduct')} />
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        {f.lines.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{t('noLines')}</p>}
        {f.lines.map((l, i) => (
          <div key={l.id} className="rounded-lg border border-border bg-surface-2/40 p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{l.name}</div>
                <div className="text-xs text-muted">{t('lineTotal')}: <b className="text-fg">{m(Math.round((Number(l.qty) || 0) * (l.cost ?? 0)))}</b></div>
              </div>
              <Button variant="ghost" size="sm" aria-label={tc('delete')} onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}><Icon name="x" className="h-4 w-4" /></Button>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label={t('quantity')}>
                <Input type="number" min="0" step="any" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
              </Field>
              <Field label={t('unitCost')}>
                <MoneyInput value={l.cost} onChange={(v) => setLine(i, { cost: v })} />
              </Field>
            </div>
          </div>
        ))}
      </div>

      {f.lines.length > 0 && <p className="mt-3 text-right text-sm">{t('total')}: <b className="text-base">{m(total)}</b></p>}

      <div className="mt-3 grid gap-3">
        {isOwner && <Checkbox checked={f.updateCostPrice} onChange={(e) => setF({ ...f, updateCostPrice: e.target.checked })} label={t('updateCostPrice')} />}
        <Field label={tc('note')}><Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <FormError error={save.error} />
    </Modal>
  );
}

function CancelModal({ doc, onClose }: { doc: any; onClose: () => void }) {
  const t = useTranslations('shop.warehouse');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [doc]);
  const run = useMutation({
    mutationFn: () => post(`/goods-receipts/${doc.id}/cancel`, { reason }),
    onSuccess: () => {
      for (const k of ['goods-receipts', 'receipt-stats', 'suppliers']) qc.invalidateQueries({ queryKey: [k] });
      toast.ok(t('cancelled'));
      onClose();
    },
  });
  return (
    <Modal
      open={!!doc}
      onClose={onClose}
      title={`${t('cancelTitle')} ${doc?.number ?? ''}`}
      footer={<><Button variant="secondary" onClick={onClose}>{tc('close')}</Button><Button variant="danger" loading={run.isPending} disabled={reason.trim().length < 2} onClick={() => run.mutate()}>{t('cancel')}</Button></>}
    >
      <p className="mb-3 text-sm text-muted">{t('cancelHint')}</p>
      <Field label={t('reason')}><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <FormError error={run.error} />
    </Modal>
  );
}
