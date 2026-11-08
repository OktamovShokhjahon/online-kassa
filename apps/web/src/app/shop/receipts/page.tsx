'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BranchSelect } from '@/components/pickers';
import { DocPage } from '@/components/DocPage';
import { Field, Input, Select, Tabs, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, useMoney } from '@/lib/format';

function SupplierSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({ queryKey: ['suppliers-all'], queryFn: () => api<any[]>('/suppliers?limit=100') });
  return <Select value={value} onChange={(e) => onChange(e.target.value)} required><option value="" />{data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>;
}

export default function ReceiptsPage() {
  const t = useTranslations('shop.receipts');
  const td = useTranslations('shop.docs');
  const router = useRouter();
  const { can } = useAuth();
  const { m } = useMoney();
  const [tab, setTab] = useState<'receipts' | 'returns'>('receipts');
  const canPost = can('stock.receipt');
  const { data: suppliers } = useQuery({ queryKey: ['suppliers-all'], queryFn: () => api<any[]>('/suppliers?limit=100') });
  const supplierName = (id: string) => suppliers?.find((s) => s.id === id)?.name ?? '';

  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'receipts', label: t('receipts') }, { key: 'returns', label: t('returns') }]} />
      {tab === 'receipts' ? (
        <DocPage
          key="gr" ns="receipts" title={t('receipts')} endpoint="/goods-receipts" canCreate={canPost} lineMode="cost" statuses={['draft', 'posted', 'cancelled']}
          blankForm={() => ({ supplierId: '', branchId: '', invoiceNo: '', invoiceDate: fmtDate(new Date()), note: '' })}
          renderHeader={(f, set) => (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('supplier')}><SupplierSelect value={f.supplierId} onChange={(v) => set({ supplierId: v })} /></Field>
              <Field label={td('branch')}><BranchSelect value={f.branchId} onChange={(v) => set({ branchId: v })} /></Field>
              <Field label={t('invoiceNo')}><Input value={f.invoiceNo} onChange={(e) => set({ invoiceNo: e.target.value })} /></Field>
              <Field label={t('invoiceDate')}><Input type="date" value={f.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} /></Field>
              <Field label={td('note')} className="md:col-span-2"><Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
            </div>
          )}
          buildBody={(f, lines) => ({ supplierId: f.supplierId, branchId: f.branchId, invoiceNo: f.invoiceNo || undefined, invoiceDate: f.invoiceDate ? new Date(f.invoiceDate).toISOString() : undefined, note: f.note || undefined, lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty, cost: l.cost ?? 0 })) })}
          columns={[{ key: 'supplierId', header: t('supplier'), render: (r: any) => supplierName(r.supplierId) }, { key: 'invoiceNo', header: t('invoiceNo') }, { key: 'total', header: td('total'), align: 'right', render: (r: any) => m(r.total) }]}
          actions={(d) => [
            ...(d.status === 'draft' && canPost ? [{ key: 'post', label: td('post'), path: `/goods-receipts/${d.id}/post`, variant: 'primary' as const }] : []),
            ...(d.status !== 'cancelled' && canPost ? [{ key: 'cancel', label: d.status === 'posted' ? t('reverse') : td('cancel'), path: `/goods-receipts/${d.id}/cancel`, variant: 'danger' as const, needsReason: true }] : []),
            ...(d.status === 'posted' && can('prices.view') ? [{ key: 'prices', label: t('openPrices'), path: '', variant: 'secondary' as const }] : []),
          ].filter((a) => a.key !== 'prices' || false)}
          detailExtra={(d) => (
            <div className="space-y-1"><p>{t('supplier')}: <b>{supplierName(d.supplierId)}</b> · {t('invoiceNo')}: {d.invoiceNo ?? '—'} · {td('total')}: <b>{m(d.total)}</b></p>
              {d.status === 'posted' && <button className="text-primary underline" onClick={() => router.push('/shop/prices')}>{t('openPrices')}</button>}</div>
          )}
        />
      ) : (
        <DocPage
          key="sr" ns="receipts" title={t('returns')} endpoint="/supplier-returns" canCreate={canPost} lineMode="cost" statuses={['draft', 'posted', 'cancelled']}
          blankForm={() => ({ supplierId: '', branchId: '', reason: '' })}
          renderHeader={(f, set) => (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('supplier')}><SupplierSelect value={f.supplierId} onChange={(v) => set({ supplierId: v })} /></Field>
              <Field label={td('branch')}><BranchSelect value={f.branchId} onChange={(v) => set({ branchId: v })} /></Field>
              <Field label={td('reason')} className="md:col-span-2"><Input value={f.reason} onChange={(e) => set({ reason: e.target.value })} /></Field>
            </div>
          )}
          buildBody={(f, lines) => ({ supplierId: f.supplierId, branchId: f.branchId, reason: f.reason, lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty, cost: l.cost ?? 0 })) })}
          columns={[{ key: 'supplierId', header: t('supplier'), render: (r: any) => supplierName(r.supplierId) }, { key: 'reason', header: td('reason') }, { key: 'total', header: td('total'), align: 'right', render: (r: any) => m(r.total) }]}
          actions={(d) => [
            ...(d.status === 'draft' && canPost ? [{ key: 'post', label: td('post'), path: `/supplier-returns/${d.id}/post`, variant: 'primary' as const }] : []),
            ...(d.status !== 'cancelled' && canPost ? [{ key: 'cancel', label: td('cancel'), path: `/supplier-returns/${d.id}/cancel`, variant: 'danger' as const, needsReason: true }] : []),
          ]}
        />
      )}
    </>
  );
}
