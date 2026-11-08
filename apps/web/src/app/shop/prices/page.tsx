'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Checkbox, DataTable, Field, FormError, Input, Modal, MoneyInput, PageHeader, Select, Spinner, useToast } from '@/components/ui';
import { ProductSearch, useBranches, useCategories, type PickedProduct } from '@/components/pickers';
import { api, del, post, put, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, useMoney } from '@/lib/format';

const ROW_H = 40;
const NAME_W = 280;
const CELL_W = 130;

export default function PricesPage() {
  const t = useTranslations('shop.prices');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const { m, currency } = useMoney();
  const toast = useToast();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'shop_admin';
  const cats = useCategories();
  const [f, setF] = useState({ q: '', categoryId: '', missingOnly: false });
  const [edits, setEdits] = useState<Record<string, number | null>>({}); // "productId:branchId" -> new price
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | 'bulk' | 'copy' | 'schedule' | { history: any }>(null);

  const { data, isLoading } = useQuery({ queryKey: ['price-matrix', f], queryFn: () => api<any>('/prices/matrix' + qs({ q: f.q, categoryId: f.categoryId, missingOnly: f.missingOnly ? 'true' : '', limit: 5000 })) });
  // the matrix endpoint returns { data: {branches, products}, meta }: api() unwraps `data`
  const branches: Array<{ id: string; name: string }> = data?.branches ?? [];
  const products: any[] = data?.products ?? [];

  const parentRef = useRef<HTMLDivElement>(null);
  const rowV = useVirtualizer({ count: products.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 12 });
  const width = NAME_W + branches.length * CELL_W + 40;
  const dirty = Object.keys(edits).length;

  const key = (p: string, b: string) => `${p}:${b}`;
  const valueOf = (p: any, b: string) => (key(p.id, b) in edits ? edits[key(p.id, b)] : (p.prices[b] ?? null));

  const save = useMutation({
    mutationFn: async () => {
      const changes = Object.entries(edits).map(([k, price]) => { const [productId, branchId] = k.split(':'); return { productId, branchId, price }; });
      for (let i = 0; i < changes.length; i += 5000) await put('/prices', { changes: changes.slice(i, i + 5000) });
    },
    onSuccess: () => { setEdits({}); qc.invalidateQueries({ queryKey: ['price-matrix'] }); toast.ok(tc('saved')); },
    onError: toast.error,
  });

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const missingCount = useMemo(() => products.filter((p) => branches.some((b) => !(b.id in p.prices))).length, [products, branches]);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={`${currency} · ${t('missingCount', { n: missingCount })}`}
        actions={<>
          <Button variant="secondary" onClick={() => setModal('schedule')}>{t('scheduled')}</Button>
          {isAdmin && <><Button variant="secondary" onClick={() => setModal('copy')}>{t('copy')}</Button><Button variant="secondary" onClick={() => setModal('bulk')}>{t('bulk')}</Button><Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>{tc('save')} {dirty > 0 && `(${dirty})`}</Button></>}
        </>}
      />
      {!isAdmin && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{t('readOnly')}</p>}
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-64" placeholder={tc('search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <Select className="w-52" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">{t('category')}: {tc('all')}</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{c.name}</option>)}</Select>
        <Checkbox checked={f.missingOnly} onChange={(e) => setF({ ...f, missingOnly: e.target.checked })} label={t('missingOnly')} className="self-center" />
      </div>

      {isLoading ? <Spinner /> : (
        <div ref={parentRef} className="max-h-[calc(100vh-18rem)] overflow-auto rounded-xl border border-border bg-surface" role="grid" aria-rowcount={products.length}>
          <div style={{ width, minWidth: '100%' }}>
            <div className="sticky top-0 z-10 flex border-b border-border bg-surface-2 text-xs font-medium text-muted" style={{ height: ROW_H }}>
              <div className="flex items-center gap-2 px-3" style={{ width: NAME_W, flexShrink: 0 }}><input type="checkbox" aria-label="select all" checked={selected.size > 0 && selected.size === products.length} onChange={(e) => setSelected(e.target.checked ? new Set(products.map((p) => p.id)) : new Set())} />{tc('name')}</div>
              {branches.map((b) => <div key={b.id} className="flex items-center justify-end px-3" style={{ width: CELL_W, flexShrink: 0 }}>{b.name}</div>)}
            </div>
            <div style={{ height: rowV.getTotalSize(), position: 'relative' }}>
              {rowV.getVirtualItems().map((vi) => {
                const p = products[vi.index];
                return (
                  <div key={p.id} role="row" className="absolute left-0 flex w-full items-center border-b border-border text-sm hover:bg-surface-2/60" style={{ top: vi.start, height: ROW_H }}>
                    <div className="flex items-center gap-2 truncate px-3" style={{ width: NAME_W, flexShrink: 0 }}>
                      <input type="checkbox" aria-label="select" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      <button className="truncate text-left hover:underline" onClick={() => setModal({ history: p })} title={p.sku ?? ''}>{p.name}</button>
                    </div>
                    {branches.map((b) => {
                      const v = valueOf(p, b.id);
                      const changed = key(p.id, b.id) in edits;
                      return (
                        <div key={b.id} role="gridcell" className="px-2" style={{ width: CELL_W, flexShrink: 0 }}>
                          {isAdmin ? (
                            <PriceCell value={v} changed={changed} onChange={(n) => setEdits((e) => { const k = key(p.id, b.id); if (n === (p.prices[b.id] ?? null)) { const { [k]: _, ...rest } = e; return rest; } return { ...e, [k]: n }; })} />
                          ) : v === null ? <Badge tone="warn">{t('none')}</Badge> : <span className="tabular block text-right">{m(v)}</span>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">{t('hint', { n: products.length })}</p>

      <BulkModal open={modal === 'bulk'} onClose={() => setModal(null)} branches={branches} selected={[...selected]} categoryId={f.categoryId} onDone={() => { qc.invalidateQueries({ queryKey: ['price-matrix'] }); setModal(null); }} />
      <CopyModal open={modal === 'copy'} onClose={() => setModal(null)} branches={branches} onDone={() => { qc.invalidateQueries({ queryKey: ['price-matrix'] }); setModal(null); }} />
      <ScheduleModal open={modal === 'schedule'} onClose={() => setModal(null)} branches={branches} isAdmin={isAdmin} />
      <HistoryModal product={typeof modal === 'object' && modal ? modal.history : null} branches={branches} onClose={() => setModal(null)} />
    </>
  );
}

function PriceCell({ value, changed, onChange }: { value: number | null; changed: boolean; onChange: (n: number | null) => void }) {
  return (
    <div className={changed ? 'rounded ring-2 ring-primary' : ''}>
      <MoneyInput value={value} onChange={onChange} className="h-8 text-right" placeholder="—" aria-label="price" />
    </div>
  );
}

function BulkModal({ open, onClose, branches, selected, categoryId, onDone }: { open: boolean; onClose: () => void; branches: any[]; selected: string[]; categoryId: string; onDone: () => void }) {
  const t = useTranslations('shop.prices');
  const tc = useTranslations('common');
  const toast = useToast();
  const [mode, setMode] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState<number | null>(null);
  const [pct, setPct] = useState('10');
  const [bs, setBs] = useState<string[]>([]);
  const run = useMutation({
    mutationFn: () => post('/prices/bulk', { branchIds: bs.length ? bs : branches.map((b) => b.id), mode, value: mode === 'percent' ? Number(pct) : value ?? 0, ...(selected.length ? { productIds: selected } : { categoryId }) }),
    onSuccess: (r) => { toast.ok(t('changed', { n: r.changed })); onDone(); },
  });
  return (
    <Modal open={open} onClose={onClose} title={t('bulk')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={run.isPending} disabled={!selected.length && !categoryId} onClick={() => run.mutate()}>{tc('confirm')}</Button></>}>
      <p className="mb-3 text-sm text-muted">{selected.length ? t('bulkSelected', { n: selected.length }) : categoryId ? t('bulkCategory') : t('bulkNeedsSelection')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('mode')}><Select value={mode} onChange={(e) => setMode(e.target.value as any)}><option value="percent">{t('percent')}</option><option value="fixed">{t('fixed')}</option></Select></Field>
        {mode === 'percent' ? <Field label="%" hint={t('percentHint')}><Input type="number" value={pct} onChange={(e) => setPct(e.target.value)} /></Field> : <Field label={t('amount')} hint={t('fixedHint')}><MoneyInput value={value} onChange={setValue} /></Field>}
      </div>
      <Field label={tc('branch')} className="mt-3" hint={t('allBranches')}><div className="flex flex-wrap gap-3">{branches.map((b) => <Checkbox key={b.id} label={b.name} checked={bs.includes(b.id)} onChange={(e) => setBs(e.target.checked ? [...bs, b.id] : bs.filter((x) => x !== b.id))} />)}</div></Field>
      <FormError error={run.error} />
    </Modal>
  );
}

function CopyModal({ open, onClose, branches, onDone }: { open: boolean; onClose: () => void; branches: any[]; onDone: () => void }) {
  const t = useTranslations('shop.prices');
  const tc = useTranslations('common');
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const run = useMutation({ mutationFn: () => post('/prices/copy', { fromBranchId: from || branches[0].id, toBranchIds: to, overwrite }), onSuccess: (r) => { toast.ok(t('changed', { n: r.changed })); onDone(); } });
  return (
    <Modal open={open} onClose={onClose} title={t('copy')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={run.isPending} disabled={!to.length} onClick={() => run.mutate()}>{tc('confirm')}</Button></>}>
      <Field label={t('from')}><Select value={from || branches[0]?.id} onChange={(e) => setFrom(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
      <Field label={t('to')} className="mt-3"><div className="flex flex-wrap gap-3">{branches.filter((b) => b.id !== (from || branches[0]?.id)).map((b) => <Checkbox key={b.id} label={b.name} checked={to.includes(b.id)} onChange={(e) => setTo(e.target.checked ? [...to, b.id] : to.filter((x) => x !== b.id))} />)}</div></Field>
      <Checkbox className="mt-3" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} label={t('overwrite')} />
      <FormError error={run.error} />
    </Modal>
  );
}

function ScheduleModal({ open, onClose, branches, isAdmin }: { open: boolean; onClose: () => void; branches: any[]; isAdmin: boolean }) {
  const t = useTranslations('shop.prices');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { m } = useMoney();
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [branchId, setBranchId] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [at, setAt] = useState('');
  const list = useQuery({ queryKey: ['scheduled-prices'], queryFn: () => api<any[]>('/price-changes' + qs({ status: 'scheduled', limit: 50 })), enabled: open });
  const add = useMutation({ mutationFn: () => post('/price-changes', { productId: product!.id, branchId: branchId || branches[0].id, newPrice: price, effectiveAt: new Date(at).toISOString() }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled-prices'] }); setProduct(null); setPrice(null); toast.ok(tc('saved')); } });
  const cancel = useMutation({ mutationFn: (id: string) => del(`/price-changes/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-prices'] }) });
  return (
    <Modal open={open} onClose={onClose} wide title={t('scheduled')} footer={<Button onClick={onClose}>{tc('close')}</Button>}>
      {isAdmin && (
        <div className="mb-4 space-y-3 rounded-lg border border-border p-3">
          {product ? <div className="flex items-center justify-between text-sm"><b>{product.name}</b><Button size="sm" variant="ghost" onClick={() => setProduct(null)}>✕</Button></div> : <ProductSearch onPick={setProduct} />}
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={tc('branch')}><Select value={branchId || branches[0]?.id} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            <Field label={t('newPrice')}><MoneyInput value={price} onChange={setPrice} /></Field>
            <Field label={t('effectiveAt')}><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          </div>
          <FormError error={add.error} />
          <Button loading={add.isPending} disabled={!product || !price || !at} onClick={() => add.mutate()}>{t('schedule')}</Button>
        </div>
      )}
      <DataTable rows={list.data} columns={[
        { key: 'productId', header: tc('name'), render: (r: any) => <span className="font-mono text-xs">{r.productId.slice(-6)}</span> },
        { key: 'branchId', header: tc('branch'), render: (r: any) => branches.find((b) => b.id === r.branchId)?.name },
        { key: 'newPrice', header: t('newPrice'), align: 'right', render: (r: any) => m(r.newPrice) },
        { key: 'effectiveAt', header: t('effectiveAt'), render: (r: any) => fmtDateTime(r.effectiveAt) },
        ...(isAdmin ? [{ key: 'a', header: '', render: (r: any) => <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>{tc('cancel')}</Button> }] : []),
      ]} />
    </Modal>
  );
}

function HistoryModal({ product, branches, onClose }: { product: any; branches: any[]; onClose: () => void }) {
  const t = useTranslations('shop.prices');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const { data } = useQuery({ queryKey: ['price-history', product?.id], queryFn: () => api<any[]>('/prices/history' + qs({ productId: product.id, limit: 50 })), enabled: !!product });
  const { data: users } = useQuery({ queryKey: ['staff-names'], queryFn: () => api<any[]>('/users' + qs({ limit: 100 })).catch(() => []), enabled: !!product });
  return (
    <Modal open={!!product} onClose={onClose} wide title={`${t('history')}: ${product?.name ?? ''}`} footer={<Button onClick={onClose}>{tc('close')}</Button>}>
      <DataTable rows={data} columns={[
        { key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) },
        { key: 'branchId', header: tc('branch'), render: (r: any) => branches.find((b) => b.id === r.branchId)?.name },
        { key: 'old', header: t('oldPrice'), align: 'right', render: (r: any) => (r.oldPrice === null ? '—' : m(r.oldPrice)) },
        { key: 'new', header: t('newPrice'), align: 'right', render: (r: any) => (r.newPrice === null ? '—' : m(r.newPrice)) },
        { key: 'source', header: t('source'), render: (r: any) => r.source },
        { key: 'user', header: t('user'), render: (r: any) => users?.find((u: any) => u.id === r.userId)?.fullName ?? '' },
      ]} />
    </Modal>
  );
}
