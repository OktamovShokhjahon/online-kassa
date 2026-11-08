'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ProductSearch, useBranches, useCategories, type PickedProduct } from '@/components/pickers';
import { Badge, DataTable, Input, PageHeader, Pagination, Select, Spinner, Stat, Tabs, useToast } from '@/components/ui';
import { api, apiPage, put, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, useMoney } from '@/lib/format';

export default function StockPage() {
  const t = useTranslations('shop.stock');
  const tc = useTranslations('common');
  const { data: branches } = useBranches();
  const [tab, setTab] = useState<'balance' | 'movements' | 'low' | 'negative'>('balance');
  const [branchId, setBranchId] = useState('');
  useEffect(() => { if (!branchId && branches?.length) setBranchId(branches[0].id); }, [branches, branchId]);
  if (!branches) return <Spinner />;
  return (
    <>
      <PageHeader title={t('title')} actions={<Select className="w-52" value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'balance', label: t('balance') }, { key: 'movements', label: t('movements') }, { key: 'low', label: t('low') }, { key: 'negative', label: t('negative') }]} />
      {branchId && tab === 'balance' && <Balance branchId={branchId} />}
      {branchId && tab === 'movements' && <Movements branchId={branchId} />}
      {branchId && (tab === 'low' || tab === 'negative') && <Exceptions kind={tab} branchId={branchId} />}
      <span className="hidden">{tc('all')}</span>
    </>
  );
}

function Balance({ branchId }: { branchId: string }) {
  const t = useTranslations('shop.stock');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const cats = useCategories();
  const [f, setF] = useState({ q: '', categoryId: '', status: '', page: 1 });
  const { data, isLoading } = useQuery({ queryKey: ['stock', branchId, f], queryFn: () => apiPage<any>('/stock' + qs({ branchId, ...f, limit: 25 })) });
  const setMin = useMutation({ mutationFn: ({ productId, minStock }: { productId: string; minStock: number }) => put('/stock/min-stock', { branchId, items: [{ productId, minStock }] }), onSuccess: () => qc.invalidateQueries({ queryKey: ['stock'] }), onError: toast.error });
  const canMin = can('stock.count') || can('stock.receipt');
  const tot = data?.meta.totals;
  return (
    <>
      {tot && <div className="mb-3 grid grid-cols-3 gap-3"><Stat label={t('totalQty')} value={tot.quantity} /><Stat label={t('valueAtCost')} value={m(tot.valueAtCost)} /><Stat label={t('valueAtPrice')} value={m(tot.valueAtPrice)} /></div>}
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-64" placeholder={tc('search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
        <Select className="w-48" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value, page: 1 })}><option value="">{t('category')}: {tc('all')}</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{c.name}</option>)}</Select>
        <Select className="w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">{tc('status')}: {tc('all')}</option>{['low', 'negative', 'zero', 'positive'].map((s) => <option key={s} value={s}>{t(`st.${s}`)}</option>)}</Select>
      </div>
      <DataTable loading={isLoading} rows={data?.data} rowKey={(r: any) => r.productId} columns={[
        { key: 'name', header: tc('name'), render: (r: any) => <div>{r.name}<div className="text-xs text-muted">{r.sku} {r.barcode}</div></div> },
        { key: 'quantity', header: t('quantity'), align: 'right', render: (r: any) => (r.quantity < 0 ? <Badge tone="danger">{r.quantity}</Badge> : r.quantity) },
        { key: 'minStock', header: t('minStock'), align: 'right', render: (r: any) => canMin ? <Input key={r.minStock} type="number" min={0} defaultValue={r.minStock} className="ml-auto h-8 w-24 text-right" onBlur={(e) => Number(e.target.value) !== r.minStock && setMin.mutate({ productId: r.productId, minStock: Number(e.target.value) })} /> : r.minStock },
        { key: 'avgCost', header: t('avgCost'), align: 'right', render: (r: any) => m(r.avgCost) },
        { key: 'price', header: t('price'), align: 'right', render: (r: any) => (r.price === null ? '—' : m(r.price)) },
        { key: 'valueAtCost', header: t('valueAtCost'), align: 'right', render: (r: any) => m(r.valueAtCost) },
        { key: 'valueAtPrice', header: t('valueAtPrice'), align: 'right', render: (r: any) => (r.valueAtPrice === null ? '—' : m(r.valueAtPrice)) },
      ]} />
      {data && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={(page) => setF({ ...f, page })} />}
    </>
  );
}

function Movements({ branchId }: { branchId: string }) {
  const t = useTranslations('shop.stock');
  const tc = useTranslations('common');
  const tt = useTranslations('shop.movementTypes');
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({ queryKey: ['stock', 'movements', branchId, product?.id, page], queryFn: () => apiPage<any>('/stock/movements' + qs({ branchId, productId: product?.id, page, limit: 25 })) });
  return (
    <>
      <div className="mb-3 max-w-md">{product ? <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"><b>{product.name}</b><button onClick={() => setProduct(null)} aria-label="clear">✕</button></div> : <ProductSearch onPick={setProduct} placeholder={t('pickProduct')} />}</div>
      <DataTable loading={isLoading} rows={data?.data} columns={[
        { key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) },
        { key: 'productName', header: tc('name') },
        { key: 'type', header: t('type'), render: (r: any) => tt(r.type) },
        { key: 'docNumber', header: t('document') },
        { key: 'quantity', header: t('quantity'), align: 'right', render: (r: any) => <span className={r.quantity < 0 ? 'text-danger' : 'text-success'}>{r.quantity > 0 ? `+${r.quantity}` : r.quantity}</span> },
        { key: 'balanceAfter', header: t('runningBalance'), align: 'right' },
      ]} />
      {data && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={setPage} />}
    </>
  );
}

function Exceptions({ kind, branchId }: { kind: 'low' | 'negative'; branchId: string }) {
  const t = useTranslations('shop.stock');
  const tc = useTranslations('common');
  const { data, isLoading } = useQuery({ queryKey: ['stock', kind, branchId], queryFn: () => api<any[]>(`/stock/${kind}` + qs({ branchId, limit: 100 })) });
  return (
    <DataTable loading={isLoading} rows={data} rowKey={(r: any) => r.productId} columns={[
      { key: 'name', header: tc('name') },
      { key: 'quantity', header: t('quantity'), align: 'right', render: (r: any) => <Badge tone={r.quantity < 0 ? 'danger' : 'warn'}>{r.quantity}</Badge> },
      ...(kind === 'low' ? [{ key: 'minStock', header: t('minStock'), align: 'right' as const }] : []),
    ]} />
  );
}
