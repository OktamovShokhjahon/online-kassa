'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PROMOTION_TYPES } from '@kass/shared';
import { ProductMultiPicker, ProductSearch, useBranches, useCategories, type PickedProduct } from '@/components/pickers';
import { Badge, Button, Checkbox, ConfirmModal, DataTable, Field, FormError, Input, Modal, MoneyInput, PageHeader, Select, useToast } from '@/components/ui';
import { api, del, post, put } from '@/lib/api';
import { fmtDate } from '@/lib/format';

interface Form {
  id?: string; name: string; type: string; priority: number; allowStack: boolean; isActive: boolean; startsAt: string; endsAt: string; branchIds: string[];
  days: number[]; from: string; to: string; percent: string; amount: number | null; buyQty: string; getQty: string; products: PickedProduct[]; categoryIds: string[]; items: Array<{ product: PickedProduct; qty: number }>; bundlePrice: number | null;
}
const blank = (): Form => ({ name: '', type: 'percent', priority: 0, allowStack: false, isActive: true, startsAt: '', endsAt: '', branchIds: [], days: [], from: '', to: '', percent: '10', amount: null, buyQty: '2', getQty: '1', products: [], categoryIds: [], items: [], bundlePrice: null });

export default function PromotionsPage() {
  const t = useTranslations('shop.promos');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const branches = useBranches();
  const cats = useCategories();
  const [edit, setEdit] = useState<Form | null>(null);
  const [remove, setRemove] = useState<any>(null);
  const { data, isLoading } = useQuery({ queryKey: ['promotions'], queryFn: () => api<any[]>('/promotions') });
  // product names for editing existing promotions
  const names = useQuery({ queryKey: ['product-names', data?.map((p) => p.id).join()], queryFn: async () => {
    const ids = new Set<string>();
    data?.forEach((p) => { p.rules.productIds?.forEach((i: string) => ids.add(i)); p.rules.items?.forEach((i: any) => ids.add(i.productId)); });
    const out: Record<string, PickedProduct> = {};
    await Promise.all([...ids].map(async (id) => { const p = await api(`/products/${id}`).catch(() => null); if (p) out[id] = { id, name: p.name }; }));
    return out;
  }, enabled: !!data });

  const toForm = (p: any): Form => ({
    id: p.id, name: p.name, type: p.type, priority: p.priority, allowStack: p.allowStack, isActive: p.isActive, startsAt: fmtDate(p.startsAt), endsAt: fmtDate(p.endsAt), branchIds: p.branchIds ?? [],
    days: p.schedule?.days ?? [], from: p.schedule?.from ?? '', to: p.schedule?.to ?? '', percent: String(p.rules.percent ?? ''), amount: p.rules.amount ?? null, buyQty: String(p.rules.buyQty ?? ''), getQty: String(p.rules.getQty ?? ''),
    products: (p.rules.productIds ?? []).map((id: string) => names.data?.[id] ?? { id, name: id.slice(-6) }), categoryIds: p.rules.categoryIds ?? [],
    items: (p.rules.items ?? []).map((i: any) => ({ product: names.data?.[i.productId] ?? { id: i.productId, name: i.productId.slice(-6) }, qty: i.qty })), bundlePrice: p.rules.bundlePrice ?? null,
  });

  const save = useMutation({
    mutationFn: (f: Form) => {
      const rules: Record<string, unknown> = {};
      if (f.type === 'percent') rules.percent = Number(f.percent);
      if (f.type === 'fixed') rules.amount = f.amount;
      if (f.type === 'buy_x_get_y') { rules.buyQty = Number(f.buyQty); rules.getQty = Number(f.getQty); }
      if (f.type === 'bundle') { rules.items = f.items.map((i) => ({ productId: i.product.id, qty: i.qty })); rules.bundlePrice = f.bundlePrice; }
      else { if (f.products.length) rules.productIds = f.products.map((p) => p.id); if (f.categoryIds.length) rules.categoryIds = f.categoryIds; }
      const hasSchedule = f.days.length || (f.from && f.to);
      const body = { name: f.name, type: f.type, priority: Number(f.priority) || 0, allowStack: f.allowStack, isActive: f.isActive, startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(`${f.endsAt}T23:59:59`).toISOString() : null, branchIds: f.branchIds, schedule: hasSchedule ? { ...(f.days.length ? { days: f.days } : {}), ...(f.from && f.to ? { from: f.from, to: f.to } : {}) } : null, rules };
      return f.id ? put(`/promotions/${f.id}`, body) : post('/promotions', body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotions'] }); setEdit(null); toast.ok(tc('saved')); },
  });
  const rm = useMutation({ mutationFn: (id: string) => del(`/promotions/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotions'] }); setRemove(null); }, onError: toast.error });
  const set = (patch: Partial<Form>) => setEdit((e) => (e ? { ...e, ...patch } : e));
  const dayNames = [0, 1, 2, 3, 4, 5, 6];

  return (
    <>
      <PageHeader title={t('title')} actions={<Button onClick={() => { save.reset(); setEdit(blank()); }}>{t('add')}</Button>} />
      <DataTable loading={isLoading} rows={data} columns={[
        { key: 'name', header: tc('name'), render: (p: any) => <span className="font-medium">{p.name}</span> },
        { key: 'type', header: t('type'), render: (p: any) => t(`types.${p.type}`) },
        { key: 'period', header: t('period'), render: (p: any) => (p.startsAt || p.endsAt ? `${fmtDate(p.startsAt) || '…'} → ${fmtDate(p.endsAt) || '…'}` : '—') },
        { key: 'priority', header: t('priority'), align: 'right' },
        { key: 'isActive', header: tc('status'), render: (p: any) => <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? tc('active') : tc('inactive')}</Badge> },
        { key: 'a', header: tc('actions'), render: (p: any) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => { save.reset(); setEdit(toForm(p)); }}>{tc('edit')}</Button><Button size="sm" variant="ghost" onClick={() => setRemove(p)}>{tc('delete')}</Button></div> },
      ]} />
      <ConfirmModal open={!!remove} onClose={() => setRemove(null)} onConfirm={() => rm.mutate(remove.id)} loading={rm.isPending} danger title={tc('delete')} message={remove?.name} />

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? tc('edit') : t('add')} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>{tc('cancel')}</Button><Button loading={save.isPending} onClick={() => edit && save.mutate(edit)}>{tc('save')}</Button></>}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={tc('name')}><Input value={edit.name} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label={t('type')}><Select value={edit.type} onChange={(e) => set({ type: e.target.value })}>{PROMOTION_TYPES.map((x) => <option key={x} value={x}>{t(`types.${x}`)}</option>)}</Select></Field>
              {edit.type === 'percent' && <Field label="%"><Input type="number" min={1} max={100} value={edit.percent} onChange={(e) => set({ percent: e.target.value })} /></Field>}
              {edit.type === 'fixed' && <Field label={t('amountPerUnit')}><MoneyInput value={edit.amount} onChange={(v) => set({ amount: v })} /></Field>}
              {edit.type === 'buy_x_get_y' && <><Field label={t('buy')}><Input type="number" min={1} value={edit.buyQty} onChange={(e) => set({ buyQty: e.target.value })} /></Field><Field label={t('get')}><Input type="number" min={1} value={edit.getQty} onChange={(e) => set({ getQty: e.target.value })} /></Field></>}
              <Field label={t('priority')} hint={t('priorityHint')}><Input type="number" value={edit.priority} onChange={(e) => set({ priority: Number(e.target.value) })} /></Field>
              <div className="flex flex-col justify-end gap-2"><Checkbox checked={edit.allowStack} onChange={(e) => set({ allowStack: e.target.checked })} label={t('allowStack')} /><Checkbox checked={edit.isActive} onChange={(e) => set({ isActive: e.target.checked })} label={tc('active')} /></div>
            </div>
            {edit.type === 'bundle' ? (
              <Field label={t('bundleItems')}>
                <div className="space-y-2">
                  {edit.items.map((it, i) => <div key={it.product.id} className="flex items-center gap-2 text-sm"><span className="flex-1">{it.product.name}</span><Input className="w-20" type="number" min={1} value={it.qty} onChange={(e) => set({ items: edit.items.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)) })} /><Button size="sm" variant="ghost" onClick={() => set({ items: edit.items.filter((_, j) => j !== i) })}>✕</Button></div>)}
                  <ProductSearch onPick={(p) => !edit.items.some((x) => x.product.id === p.id) && set({ items: [...edit.items, { product: p, qty: 1 }] })} />
                  <Field label={t('bundlePrice')}><MoneyInput value={edit.bundlePrice} onChange={(v) => set({ bundlePrice: v })} /></Field>
                </div>
              </Field>
            ) : (
              <>
                <Field label={t('products')} hint={t('targetHint')}><ProductMultiPicker value={edit.products} onChange={(v) => set({ products: v })} /></Field>
                <Field label={t('categories')}><div className="flex flex-wrap gap-3">{cats.data?.map((c) => <Checkbox key={c.id} label={c.name} checked={edit.categoryIds.includes(c.id)} onChange={(e) => set({ categoryIds: e.target.checked ? [...edit.categoryIds, c.id] : edit.categoryIds.filter((x) => x !== c.id) })} />)}</div></Field>
              </>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('startsAt')}><Input type="date" value={edit.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></Field>
              <Field label={t('endsAt')}><Input type="date" value={edit.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
              <Field label={t('fromTime')} hint={t('timeHint')}><Input type="time" value={edit.from} onChange={(e) => set({ from: e.target.value })} /></Field>
              <Field label={t('toTime')}><Input type="time" value={edit.to} onChange={(e) => set({ to: e.target.value })} /></Field>
            </div>
            <Field label={t('days')}><div className="flex flex-wrap gap-3">{dayNames.map((d) => <Checkbox key={d} label={t(`wd${d}`)} checked={edit.days.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...edit.days, d] : edit.days.filter((x) => x !== d) })} />)}</div></Field>
            <Field label={tc('branch')} hint={t('allBranches')}><div className="flex flex-wrap gap-3">{branches.data?.map((b) => <Checkbox key={b.id} label={b.name} checked={edit.branchIds.includes(b.id)} onChange={(e) => set({ branchIds: e.target.checked ? [...edit.branchIds, b.id] : edit.branchIds.filter((x) => x !== b.id) })} />)}</div></Field>
            <FormError error={save.error} />
          </div>
        )}
      </Modal>
    </>
  );
}
