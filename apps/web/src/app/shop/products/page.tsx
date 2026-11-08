'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { inventoryEnabled } from '@kass/shared';
import { IMPORT_FIELDS, UNITS } from '@kass/shared';
import { ProductCodes, downloadCodePng, downloadCodesZip } from '@/components/codes';
import { Icon } from '@/components/icons';
import { Badge, Button, Checkbox, ConfirmModal, DataTable, Field, FormError, Input, Modal, MoneyInput, PageHeader, Pagination, Select, useToast } from '@/components/ui';
import { api, apiPage, apiRaw, del, download, patch, post, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMoney } from '@/lib/format';

type Form = {
  id?: string; name: string; sku: string; barcodes: string[]; categoryId: string; unit: string; isWeighted: boolean; vatRate: string; mxikCode: string; packageCode: string; isMarked: boolean; isActive: boolean;
  /** One selling price for every branch (the simple form) ... */
  price: number | null;
  /** ... or a price per branch (more settings). */
  perBranch: boolean;
  prices: Record<string, number | null>;
  costPrice: number | null;
};
const blank = (): Form => ({ name: '', sku: '', barcodes: [], categoryId: '', unit: 'piece', isWeighted: false, vatRate: '', mxikCode: '', packageCode: '', isMarked: false, isActive: true, price: null, perBranch: false, prices: {}, costPrice: null });

export default function ProductsPage() {
  const t = useTranslations('shop.products');
  const tc = useTranslations('common');
  const tu = useTranslations('shop.units');
  const { can, user, shop } = useAuth();
  const { m, currency } = useMoney();
  const toast = useToast();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'shop_admin';
  const canManage = can('products.manage');
  const [f, setF] = useState({ q: '', categoryId: '', active: '', branchId: '', filter: '', page: 1 });
  const [edit, setEdit] = useState<Form | null>(null);
  const [labelFor, setLabelFor] = useState<any>(null);
  const [importOpen, setImportOpen] = useState(false);

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api<any[]>('/branches') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/categories') });
  const branchId = f.branchId || branches.data?.[0]?.id || '';
  const params = { q: f.q, categoryId: f.categoryId, active: f.active, page: f.page, limit: 20, branchId, ...(f.filter === 'missingMxik' ? { missingMxik: 'true' } : {}), ...(f.filter === 'missingPrice' ? { missingPriceBranchId: branchId } : {}), ...(['low', 'negative', 'out'].includes(f.filter) ? { stockStatus: f.filter } : {}) };
  const { data, isLoading } = useQuery({ queryKey: ['products', params], queryFn: () => apiPage('/products' + qs(params)), enabled: !!branches.data });

  async function open(row?: any) {
    save.reset();
    if (!row) {
      setEdit(blank());
      setShown(0);
      setAutoCode(null);
      setMore(false);
      return;
    }
    setShown(0);
    const full = await api(`/products/${row.id}`);
    const prices: Record<string, number | null> = Object.fromEntries((full.prices ?? []).map((p: any) => [p.branchId, p.price]));
    const distinct = [...new Set(Object.values(prices))];
    const perBranch = distinct.length > 1 || (distinct.length === 1 && Object.keys(prices).length < (branches.data?.length ?? 1));
    setEdit({ id: full.id, name: full.name, sku: full.sku ?? '', barcodes: full.barcodes, categoryId: full.categoryId ?? '', unit: full.unit, isWeighted: full.isWeighted, vatRate: full.vatRate ?? '', mxikCode: full.mxikCode ?? '', packageCode: full.packageCode ?? '', isMarked: full.isMarked, isActive: full.isActive, price: perBranch ? null : (distinct[0] ?? null), perBranch, prices, costPrice: full.costPrice ?? null });
    setMore(perBranch);
  }

  const save = useMutation({
    mutationFn: async (form: Form) => {
      const body: any = { name: form.name.trim(), sku: form.sku || undefined, barcodes: [...new Set(form.barcodes.map((b) => b.trim()).filter(Boolean))], categoryId: form.categoryId || null, unit: form.unit, isWeighted: form.isWeighted, vatRate: form.vatRate === '' ? null : Number(form.vatRate), mxikCode: form.mxikCode || null, packageCode: form.packageCode || null, isMarked: form.isMarked, isActive: form.isActive };
      if (isAdmin) body.costPrice = form.costPrice;
      // the simple price goes to every branch; per-branch prices only when chosen under "more settings"
      const branchPrices = (branches.data ?? []).map((b) => ({ branchId: b.id as string, price: form.perBranch ? form.prices[b.id] ?? null : form.price })).filter((x): x is { branchId: string; price: number } => !!x.price);
      if (form.id) {
        if (!form.sku) body.sku = '';
        await patch(`/products/${form.id}`, body);
        if (isAdmin && branchPrices.length) await api('/prices', { method: 'PUT', json: { changes: branchPrices.map((x) => ({ productId: form.id, ...x })) } });
      } else {
        if (isAdmin) body.prices = branchPrices;
        await post('/products', body);
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); setEdit(null); toast.ok(tc('saved')); },
  });

  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del(`/products/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); setDeleting(null); setEdit(null); toast.ok(t('deleted')); },
    onError: (e) => { setDeleting(null); toast.error(e); },
  });
  const [barcodeInput, setBarcodeInput] = useState('');
  const addBarcode = () => {
    const b = barcodeInput.trim();
    if (b && edit && !edit.barcodes.includes(b)) setEdit({ ...edit, barcodes: [...edit.barcodes, b] });
    setBarcodeInput('');
  };
  const [shown, setShown] = useState(0);
  /** "More settings" of the product form (closed: the form is just name, prices and the code). */
  const [more, setMore] = useState(false);
  /** The barcode filled in automatically for a new product: `pending` while it is being reserved. */
  const [autoCode, setAutoCode] = useState<string | null>(null);
  const isNew = !!edit && !edit.id;
  const hasName = !!edit?.name.trim();
  const noCodes = !!edit && edit.barcodes.length === 0;
  // A new product gets its barcode (and QR code) as soon as a name is typed; it stays editable.
  useEffect(() => {
    if (!isNew || !hasName || !noCodes || autoCode) return;
    const timer = window.setTimeout(() => {
      setAutoCode('pending');
      post<{ code: string }>('/products/reserve-barcode')
        .then((r) => {
          setAutoCode(r.code);
          setEdit((e) => (e && !e.id && !e.barcodes.length ? { ...e, barcodes: [r.code] } : e));
          setShown(0);
        })
        // one attempt only: a failure must not turn every typed letter into an error message
        .catch(() => setAutoCode('failed'));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [isNew, hasName, noCodes, autoCode]);
  /** The code being shown, or a freshly generated internal one when the product has none yet. */
  const ensureCode = async (): Promise<string | null> => {
    if (!edit) return null;
    const current = edit.barcodes[Math.min(shown, edit.barcodes.length - 1)]?.trim();
    if (current) return current;
    if (edit.id) {
      const p = await post(`/products/${edit.id}/generate-barcode`);
      setEdit((e) => (e ? { ...e, barcodes: p.barcodes } : e));
      setShown(p.barcodes.length - 1);
      qc.invalidateQueries({ queryKey: ['products'] });
      return p.barcodes[p.barcodes.length - 1];
    }
    const r = await post<{ code: string }>('/products/reserve-barcode');
    setEdit((e) => (e ? { ...e, barcodes: [...e.barcodes, r.code] } : e));
    setShown(0);
    return r.code;
  };
  const [busyCode, setBusyCode] = useState<'barcode' | 'qr' | null>(null);
  const generateAndDownload = async (kind: 'barcode' | 'qr') => {
    setBusyCode(kind);
    try {
      const code = await ensureCode();
      if (code) await downloadCodePng(kind, code, edit?.name);
    } catch (e) { toast.error(e); } finally { setBusyCode(null); }
  };
  const [exporting, setExporting] = useState<'barcode' | 'qr' | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** One ZIP: the PDF sheet of every product's code + images/ with a PNG per product. */
  const exportCodes = async (kind: 'barcode' | 'qr') => {
    setExporting(kind);
    setProgress(null);
    try {
      // the list comes first: products without a barcode get one here, so the PDF has them too
      const list = await api<{ items: Array<{ name: string; code: string }>; generated: number }>(`/products/codes?type=${kind}&format=json`);
      const res = await apiRaw(`/products/codes?type=${kind}`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? res.statusText);
      await downloadCodesZip(kind, list.items, await res.blob(), (done, total) => setProgress({ done, total }));
      toast.ok(t('codesExported', { count: list.items.length }));
      if (list.generated) { toast.ok(t('codesGenerated', { count: list.generated })); qc.invalidateQueries({ queryKey: ['products'] }); }
    } catch (e) { toast.error(e); } finally { setExporting(null); setProgress(null); }
  };
  const uploadImage = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await apiRaw(`/products/${edit!.id}/image`, { method: 'POST', form: fd });
    res.ok ? toast.ok(tc('saved')) : toast.error(new Error((await res.json()).error?.message));
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        actions={<>
          <Button variant="secondary" onClick={() => download('/products/export', 'products.xlsx').catch(toast.error)}>{tc('export')}</Button>
          <Button variant="secondary" loading={exporting === 'qr'} disabled={!!exporting} onClick={() => exportCodes('qr')}><Icon name="arrowDown" className="h-4 w-4" />{t('exportQr')}{exporting === 'qr' && progress ? ` ${progress.done}/${progress.total}` : ''}</Button>
          <Button variant="secondary" loading={exporting === 'barcode'} disabled={!!exporting} onClick={() => exportCodes('barcode')}><Icon name="arrowDown" className="h-4 w-4" />{t('exportBarcodes')}{exporting === 'barcode' && progress ? ` ${progress.done}/${progress.total}` : ''}</Button>
          {canManage && <Button variant="secondary" onClick={() => setImportOpen(true)}>{tc('import')}</Button>}
          {canManage && <Button onClick={() => open()}>{t('add')}</Button>}
        </>}
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-64" placeholder={t('searchHint')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
        <Select className="w-48" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value, page: 1 })}><option value="">{t('category')}: {tc('all')}</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{c.name}</option>)}</Select>
        <Select className="w-40" value={f.active} onChange={(e) => setF({ ...f, active: e.target.value, page: 1 })}><option value="">{tc('status')}: {tc('all')}</option><option value="true">{tc('active')}</option><option value="false">{tc('inactive')}</option></Select>
        <Select className="w-52" value={f.filter} onChange={(e) => setF({ ...f, filter: e.target.value, page: 1 })}>
          <option value="">{t('filter')}: {tc('all')}</option><option value="missingPrice">{t('missingPrice')}</option>{shop?.fiscalEnabled && <option value="missingMxik">{t('missingMxik')}</option>}{inventoryEnabled() && <><option value="low">{t('lowStock')}</option><option value="negative">{t('negativeStock')}</option><option value="out">{t('outOfStock')}</option></>}
        </Select>
        {(branches.data?.length ?? 0) > 1 && <Select className="w-44" value={branchId} onChange={(e) => setF({ ...f, branchId: e.target.value, page: 1 })}>{branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}
      </div>
      <DataTable
        loading={isLoading}
        rows={data?.data}
        onRowClick={canManage ? open : undefined}
        columns={[
          { key: 'name', header: tc('name'), render: (r: any) => <div><span className="font-medium">{r.name}</span> {!r.isActive && <Badge>{tc('inactive')}</Badge>}<div className="text-xs text-muted">{r.sku}</div></div> },
          { key: 'barcodes', header: t('barcodes'), render: (r: any) => <span className="font-mono text-xs">{r.barcodes.join(', ')}</span> },
          { key: 'unit', header: t('unit'), render: (r: any) => tu(r.unit) },
          { key: 'price', header: `${t('price')}`, align: 'right', render: (r: any) => (r.price === null || r.price === undefined ? <Badge tone="warn">{t('noPrice')}</Badge> : m(r.price)) },
          { key: 'a', header: '', align: 'right', render: (r: any) => (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setLabelFor(r); }}>🏷</Button>
              {canManage && <Button size="sm" variant="ghost" aria-label={tc('delete')} title={tc('delete')} className="text-muted hover:bg-danger/10 hover:text-danger" onClick={(e) => { e.stopPropagation(); setDeleting({ id: r.id, name: r.name }); }}><Icon name="x" className="h-4 w-4" /></Button>}
            </div>
          ) },
        ]}
      />
      {data && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={(page) => setF({ ...f, page })} />}

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? tc('edit') : t('add')} footer={<>{edit?.id && <Button variant="ghost" className="mr-auto text-danger hover:bg-danger/10" onClick={() => setDeleting({ id: edit.id!, name: edit.name })}><Icon name="x" className="h-4 w-4" />{tc('delete')}</Button>}<Button variant="secondary" onClick={() => setEdit(null)}>{tc('cancel')}</Button><Button loading={save.isPending} onClick={() => edit && save.mutate(edit)}>{tc('save')}</Button></>}>
        {edit && (
          <div className="space-y-4">
            <Field label={tc('name')}><Input autoFocus className="h-11 text-base" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></Field>
            {isAdmin ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {!edit.perBranch && <Field label={`${t('salePrice')} (${currency})`}><MoneyInput value={edit.price} onChange={(v) => setEdit({ ...edit, price: v })} /></Field>}
                <Field label={`${t('costPrice')} (${currency})`} className={edit.perBranch ? 'sm:col-span-2' : ''}><MoneyInput value={edit.costPrice} onChange={(v) => setEdit({ ...edit, costPrice: v })} /></Field>
                {!edit.perBranch && !!edit.price && edit.costPrice !== null && (
                  <p className={`anim-fade -mt-1 rounded-lg px-3 py-2 text-sm sm:col-span-2 ${edit.price - edit.costPrice >= 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}>
                    {t('profitPerUnit', { amount: m(edit.price - edit.costPrice), percent: Math.round(((edit.price - edit.costPrice) / edit.price) * 100) })}
                  </p>
                )}
              </div>
            ) : <p className="text-xs text-muted">{t('adminOnlyPrices')}</p>}
            {shop?.fiscalEnabled && (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t('mxik')} hint={t('mxikHint')}><Input inputMode="numeric" maxLength={17} value={edit.mxikCode} onChange={(e) => setEdit({ ...edit, mxikCode: e.target.value })} /></Field>
                <Field label={t('packageCode')}><Input inputMode="numeric" value={edit.packageCode} onChange={(e) => setEdit({ ...edit, packageCode: e.target.value })} /></Field>
              </div>
            )}
            <Field label={t('barcodes')} hint={t('barcodeHint')}>
              <div className="space-y-2">
                {edit.barcodes.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">{autoCode === 'pending' ? t('autoCodeWorking') : autoCode === 'failed' ? t('autoCodeFailed') : isNew ? t('autoCodeWaiting') : t('noCodesYet')}</p>
                )}
                <div className="space-y-1.5">
                  {edit.barcodes.map((b, i) => {
                    const active = i === Math.min(shown, edit.barcodes.length - 1);
                    return (
                      <div key={i} className={`flex items-center gap-2 rounded-lg border p-1 pl-2 transition-colors ${active ? 'border-primary/40 bg-primary/5' : 'border-transparent'}`}>
                        <Input
                          aria-label={t('barcodes')}
                          className="h-9 font-mono"
                          value={b}
                          inputMode="text"
                          spellCheck={false}
                          onFocus={() => setShown(i)}
                          onChange={(e) => { const v = e.target.value.replace(/\s+/g, ''); setEdit({ ...edit, barcodes: edit.barcodes.map((x, j) => (j === i ? v : x)) }); setShown(i); }}
                        />
                        {b === autoCode && <Badge tone="info">{t('autoCode')}</Badge>}
                        <button type="button" aria-label={tc('delete')} className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger" onClick={(e) => { e.preventDefault(); setEdit({ ...edit, barcodes: edit.barcodes.filter((_, j) => j !== i) }); setShown(0); }}><Icon name="x" className="h-4 w-4" /></button>
                      </div>
                    );
                  })}
                </div>
                {edit.barcodes[Math.min(shown, edit.barcodes.length - 1)]?.trim() && <ProductCodes code={edit.barcodes[Math.min(shown, edit.barcodes.length - 1)].trim()} name={edit.name} />}
                <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" className="whitespace-nowrap" title={t('genHint')} loading={busyCode === 'barcode'} onClick={() => generateAndDownload('barcode')}><Icon name="arrowDown" className="h-4 w-4" />{t('genBarcode')}</Button><Button type="button" variant="secondary" className="whitespace-nowrap" title={t('genHint')} loading={busyCode === 'qr'} onClick={() => generateAndDownload('qr')}><Icon name="arrowDown" className="h-4 w-4" />{t('genQr')}</Button></div>
              </div>
            </Field>

            <button type="button" onClick={() => setMore(!more)} aria-expanded={more} className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <Icon name="chevron" className={`h-4 w-4 transition-transform ${more ? "" : "-rotate-90"}`} />
              {t('moreSettings')}
              <span className="ml-auto hidden text-xs font-normal sm:inline">{t('moreSettingsHint')}</span>
            </button>
            {more && (
              <div className="anim-fade space-y-4 rounded-xl border border-border p-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={t('sku')}><Input value={edit.sku} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
                  <Field label={t('category')}><Select value={edit.categoryId} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value })}><option value="" />{cats.data?.map((c) => <option key={c.id} value={c.id}>{'— '.repeat(c.depth - 1)}{c.name}</option>)}</Select></Field>
                  <Field label={t('unit')}><Select value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{tu(u)}</option>)}</Select></Field>
                  <Field label={t('vat')}><Input type="number" min={0} max={100} value={edit.vatRate} onChange={(e) => setEdit({ ...edit, vatRate: e.target.value })} /></Field>
                </div>
                <div className="flex flex-wrap gap-4"><Checkbox checked={edit.isWeighted} onChange={(e) => setEdit({ ...edit, isWeighted: e.target.checked })} label={t('weighted')} /><Checkbox checked={edit.isMarked} onChange={(e) => setEdit({ ...edit, isMarked: e.target.checked })} label={t('marked')} /><Checkbox checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} label={tc('active')} /></div>
                <Field label={t('extraBarcode')}>
                  <div className="flex gap-2"><Input value={barcodeInput} onChange={(e) => setBarcodeInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBarcode(); } }} placeholder={t('scanOrType')} /><Button type="button" variant="secondary" className="shrink-0" onClick={addBarcode}>+</Button></div>
                </Field>
                {isAdmin && (branches.data?.length ?? 0) > 1 && (
                  <div className="space-y-2">
                    <Checkbox checked={edit.perBranch} help={false} onChange={(e) => setEdit({ ...edit, perBranch: e.target.checked, prices: e.target.checked ? Object.fromEntries((branches.data ?? []).map((b) => [b.id, edit.prices[b.id] ?? edit.price])) : edit.prices })} label={t('pricePerBranch')} />
                    {edit.perBranch && (
                      <Field label={`${t('pricesByBranch')} (${currency})`} hint={t('pricesHint')}>
                        <div className="grid gap-2 md:grid-cols-2">{branches.data?.map((b) => <div key={b.id} className="flex items-center gap-2"><span className="w-32 truncate text-sm">{b.name}</span><MoneyInput value={edit.prices[b.id] ?? null} onChange={(v) => setEdit({ ...edit, prices: { ...edit.prices, [b.id]: v } })} /></div>)}</div>
                      </Field>
                    )}
                  </div>
                )}
                {edit.id && <Field label={t('image')}><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])} /></Field>}
              </div>
            )}
            <FormError error={save.error} />
          </div>
        )}
      </Modal>

      <LabelModal product={labelFor} branches={branches.data ?? []} onClose={() => setLabelFor(null)} />
      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
        danger
        title={t('deleteTitle')}
        message={t('deleteConfirm', { name: deleting?.name ?? '' })}
      />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} branches={branches.data ?? []} isAdmin={isAdmin} onDone={() => qc.invalidateQueries({ queryKey: ['products'] })} />
    </>
  );
}

function LabelModal({ product, branches, onClose }: { product: any; branches: any[]; onClose: () => void }) {
  const t = useTranslations('shop.products');
  const tc = useTranslations('common');
  const toast = useToast();
  const [branchId, setBranchId] = useState('');
  const [copies, setCopies] = useState(8);
  const run = async () => {
    const res = await apiRaw('/products/labels', { method: 'POST', json: { branchId: branchId || branches[0]?.id, items: [{ productId: product.id, copies }] } });
    if (!res.ok) return toast.error(new Error((await res.json()).error?.message));
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank');
  };
  return (
    <Modal open={!!product} onClose={onClose} title={t('labels')} footer={<><Button variant="secondary" onClick={onClose}>{tc('close')}</Button><Button onClick={run}>PDF</Button></>}>
      <p className="mb-3 text-sm">{product?.name}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={tc('branch')}><Select value={branchId || branches[0]?.id} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label={t('copies')}><Input type="number" min={1} max={100} value={copies} onChange={(e) => setCopies(Number(e.target.value))} /></Field>
      </div>
    </Modal>
  );
}

function ImportModal({ open, onClose, branches, isAdmin, onDone }: { open: boolean; onClose: () => void; branches: any[]; isAdmin: boolean; onDone: () => void }) {
  const t = useTranslations('shop.products');
  const tc = useTranslations('common');
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [priceBranches, setPriceBranches] = useState<string[]>([]);
  const [update, setUpdate] = useState(true);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setFile(null); setPreview(null); setResult(null); setMapping({}); };
  const pick = async (f: File) => {
    setFile(f); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await apiRaw('/products/import/preview', { method: 'POST', form: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message);
      setPreview(json.data); setMapping(json.data.suggestedMapping);
    } catch (e) { toast.error(e); reset(); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file!);
      fd.append('options', JSON.stringify({ mapping, updateExisting: update, priceBranchIds: mapping.price ? priceBranches : [] }));
      const res = await apiRaw('/products/import', { method: 'POST', form: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message);
      setResult(json.data); onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} wide title={t('importTitle')} footer={result ? <Button onClick={() => { reset(); onClose(); }}>{tc('close')}</Button> : <><Button variant="secondary" onClick={() => { reset(); onClose(); }}>{tc('cancel')}</Button><Button loading={busy} disabled={!preview || !mapping.name} onClick={run}>{tc('import')}</Button></>}>
      {!preview && !result && <><p className="mb-3 text-sm text-muted">{t('importHint')}</p><input type="file" accept=".xlsx,.csv,.txt" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} /></>}
      {preview && !result && (
        <div className="space-y-4">
          <p className="text-sm">{t('rows', { n: preview.totalRows })}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {IMPORT_FIELDS.map((k) => (
              <Field key={k} label={t(`col.${k}`)}><Select value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value })}><option value="">—</option>{preview.columns.map((c: string) => <option key={c}>{c}</option>)}</Select></Field>
            ))}
          </div>
          <Checkbox checked={update} onChange={(e) => setUpdate(e.target.checked)} label={t('updateExisting')} />
          {isAdmin && mapping.price && <Field label={t('priceBranches')}><div className="flex flex-wrap gap-3">{branches.map((b) => <Checkbox key={b.id} label={b.name} checked={priceBranches.includes(b.id)} onChange={(e) => setPriceBranches(e.target.checked ? [...priceBranches, b.id] : priceBranches.filter((x) => x !== b.id))} />)}</div></Field>}
          <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{preview.columns.map((c: string) => <th key={c} className="px-2 py-1 text-left text-muted">{c}</th>)}</tr></thead><tbody>{preview.sample.slice(0, 5).map((r: string[], i: number) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="px-2 py-1">{c}</td>)}</tr>)}</tbody></table></div>
        </div>
      )}
      {result && (
        <div className="space-y-3 text-sm">
          <p><Badge tone="success">{t('created')}: {result.created}</Badge> <Badge tone="info">{t('updated')}: {result.updated}</Badge> <Badge>{t('skipped')}: {result.skipped}</Badge> <Badge tone={result.errors.length ? 'danger' : 'neutral'}>{t('errors')}: {result.errors.length}</Badge> {result.pricesSet > 0 && <Badge>{t('pricesSet')}: {result.pricesSet}</Badge>}</p>
          {result.errors.length > 0 && <ul className="max-h-56 overflow-y-auto rounded-lg bg-surface-2 p-2 text-xs">{result.errors.map((e: any, i: number) => <li key={i}>{t('row')} {e.row}: {e.message}</li>)}</ul>}
        </div>
      )}
    </Modal>
  );
}
