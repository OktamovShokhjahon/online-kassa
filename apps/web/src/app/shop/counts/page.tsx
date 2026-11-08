'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { BranchSelect, useCategories } from '@/components/pickers';
import { ApiError, api, apiPage, post, put, qs } from '@/lib/api';
import { QuickProductModal } from '@/components/docs';
import { Badge, Button, Checkbox, DataTable, Field, FormError, Input, Modal, PageHeader, Pagination, Select, useToast } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';

export default function CountsPage() {
  const t = useTranslations('shop.counts');
  const td = useTranslations('shop.docs');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const ok = can('stock.count');
  const cats = useCategories();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState<{ branchId: string; categoryId: string; prefill: boolean } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['stock-counts', page], queryFn: () => apiPage<any>('/stock-counts' + qs({ page, limit: 20 })) });
  const create = useMutation({
    mutationFn: () => post('/stock-counts', { branchId: creating!.branchId, categoryId: creating!.categoryId || undefined, prefill: creating!.prefill }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['stock-counts'] }); setCreating(null); setOpenId(c.id); },
  });

  return (
    <>
      <PageHeader title={t('title')} actions={ok && <Button onClick={() => { create.reset(); setCreating({ branchId: '', categoryId: '', prefill: true }); }}>{tc('create')}</Button>} />
      <DataTable loading={list.isLoading} rows={list.data?.data} onRowClick={(r) => setOpenId(r.id)} columns={[
        { key: 'number', header: '№', render: (r: any) => <span className="font-mono">{r.number}</span> },
        { key: 'lineCount', header: t('lines'), align: 'right' },
        { key: 'status', header: tc('status'), render: (r: any) => <Badge tone={r.status === 'posted' ? 'success' : r.status === 'cancelled' ? 'danger' : 'neutral'}>{td(`status.${r.status}`)}</Badge> },
        { key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) },
      ]} />
      {list.data && <Pagination page={list.data.meta.page} limit={list.data.meta.limit} total={list.data.meta.total} onPage={setPage} />}

      <Modal open={!!creating} onClose={() => setCreating(null)} title={t('new')} footer={<><Button variant="secondary" onClick={() => setCreating(null)}>{tc('cancel')}</Button><Button loading={create.isPending} disabled={!creating?.branchId} onClick={() => create.mutate()}>{tc('create')}</Button></>}>
        {creating && <div className="space-y-3">
          <Field label={tc('branch')}><BranchSelect value={creating.branchId} onChange={(v) => setCreating({ ...creating, branchId: v })} /></Field>
          <Field label={t('category')} hint={t('categoryHint')}><Select value={creating.categoryId} onChange={(e) => setCreating({ ...creating, categoryId: e.target.value })}><option value="">{tc('all')}</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{c.name}</option>)}</Select></Field>
          <Checkbox checked={creating.prefill} onChange={(e) => setCreating({ ...creating, prefill: e.target.checked })} label={t('prefill')} />
          <FormError error={create.error} />
        </div>}
      </Modal>
      {openId && <CountSheet id={openId} canEdit={ok} onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['stock-counts'] }); qc.invalidateQueries({ queryKey: ['stock'] }); }} />}
    </>
  );
}

function CountSheet({ id, canEdit, onClose }: { id: string; canEdit: boolean; onClose: () => void }) {
  const t = useTranslations('shop.counts');
  const td = useTranslations('shop.docs');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ['stock-count', id], queryFn: () => api<any>(`/stock-counts/${id}`) });
  const [counted, setCounted] = useState<Record<string, number | null>>({});
  const [scan, setScan] = useState('');
  const [unknown, setUnknown] = useState<string | null>(null);
  const [zero, setZero] = useState(false);
  const [extra, setExtra] = useState<Record<string, { name: string; barcode?: string }>>({});
  useEffect(() => { if (data) setCounted(Object.fromEntries(data.lines.map((l: any) => [l.productId, l.counted]))); }, [data]);
  const isDirty = () => !!data && Object.entries(counted).some(([pid, c]) => (c ?? null) !== (data.lines.find((x: any) => x.productId === pid)?.counted ?? null));
  const save = useMutation({
    mutationFn: () => put(`/stock-counts/${id}/lines`, { lines: Object.entries(counted).filter(([, c]) => c !== undefined).map(([productId, c]) => ({ productId, counted: c })) }),
    onSuccess: () => { toast.ok(tc('saved')); refetch(); },
    onError: toast.error,
  });
  const run = useMutation({
    mutationFn: async (action: 'post' | 'cancel') => {
      if (isDirty()) await save.mutateAsync();
      return post(`/stock-counts/${id}/${action}`, action === 'post' ? { zeroUncounted: zero } : { reason: 'cancelled' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stock-counts'] }); refetch(); },
    onError: toast.error,
  });

  if (!data) return null;
  const draft = data.status === 'draft';

  const lines: any[] = [...data.lines, ...Object.entries(extra).filter(([pid]) => !data.lines.some((l: any) => l.productId === pid)).map(([pid, e]) => ({ productId: pid, productName: e.name, barcode: e.barcode, expected: 0, counted: null }))];
  const diff = (l: any) => (counted[l.productId] === null || counted[l.productId] === undefined ? null : Math.round((counted[l.productId]! - (l.expected ?? 0)) * 1000) / 1000);
  const dirty = lines.some((l) => (counted[l.productId] ?? null) !== (data.lines.find((x: any) => x.productId === l.productId)?.counted ?? null));

  const addProduct = (p: { id: string; name: string; barcode?: string }) => {
    setExtra((e) => ({ ...e, [p.id]: { name: p.name, barcode: p.barcode } }));
    setCounted((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }));
  };
  const onScan = async (code: string) => {
    setScan('');
    if (!code.trim()) return;
    try {
      const p = await api(`/products/by-barcode/${encodeURIComponent(code.trim())}`);
      addProduct({ id: p.id, name: p.name, barcode: code.trim() });
    } catch (e) { if (e instanceof ApiError && e.status === 404) setUnknown(code.trim()); else toast.error(e); }
  };

  return (
    <Modal open wide onClose={onClose} title={`${data.number} · ${td(`status.${data.status}`)}`} footer={<>
      {draft && canEdit && <><Button variant="danger" onClick={() => run.mutate('cancel')}>{td('cancel')}</Button><Button variant="secondary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>{tc('save')}</Button><Button loading={run.isPending} onClick={() => run.mutate('post')}>{t('postAdjust')}</Button></>}
      <Button variant="secondary" onClick={onClose}>{tc('close')}</Button>
    </>}>
      {draft && canEdit && (
        <div className="mb-3 space-y-2">
          <Input value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onScan(scan); } }} placeholder={td('scanBarcode')} autoFocus />
          <Checkbox checked={zero} onChange={(e) => setZero(e.target.checked)} label={t('zeroUncounted')} />
        </div>
      )}
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs text-muted"><tr><th className="px-3 py-2 text-left">{tc('name')}</th><th className="px-3 py-2 text-right">{t('expected')}</th><th className="w-32 px-3 py-2 text-right">{td('counted')}</th><th className="px-3 py-2 text-right">{t('difference')}</th></tr></thead>
          <tbody>
            {lines.map((l) => {
              const d = diff(l);
              return (
                <tr key={l.productId} className="border-t border-border">
                  <td className="px-3 py-1.5">{l.productName}<div className="font-mono text-xs text-muted">{l.barcode}</div></td>
                  <td className="tabular px-3 py-1.5 text-right">{l.expected}</td>
                  <td className="px-3 py-1.5">{draft && canEdit ? <Input type="number" step="0.001" min={0} className="h-8 text-right" value={counted[l.productId] ?? ''} onChange={(e) => setCounted({ ...counted, [l.productId]: e.target.value === '' ? null : Number(e.target.value) })} /> : <span className="tabular block text-right">{l.counted ?? '—'}</span>}</td>
                  <td className={`tabular px-3 py-1.5 text-right ${d ? (d < 0 ? 'text-danger' : 'text-success') : 'text-muted'}`}>{d === null ? '' : d > 0 ? `+${d}` : d}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <QuickProductModal barcode={unknown} onClose={() => setUnknown(null)} onCreated={(p) => { addProduct(p); setUnknown(null); }} />
    </Modal>
  );
}
