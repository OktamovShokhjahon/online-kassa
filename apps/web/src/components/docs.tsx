'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { UNITS } from '@kass/shared';
import { ApiError, api, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProductSearch, type PickedProduct } from './pickers';
import { Button, Field, FormError, Input, Modal, MoneyInput, Select, useToast } from './ui';

export interface DocLine { product: PickedProduct; qty: number; cost?: number | null; counted?: number | null }

/** Quick "create product" form opened when an unknown barcode is scanned (spec 5.8). */
export function QuickProductModal({ barcode, onClose, onCreated }: { barcode: string | null; onClose: () => void; onCreated: (p: PickedProduct) => void }) {
  const tp = useTranslations('shop.products');
  const tc = useTranslations('common');
  const tu = useTranslations('shop.units');
  const { can } = useAuth();
  const [f, setF] = useState({ name: '', unit: 'piece' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await post('/products', { name: f.name, unit: f.unit, isWeighted: f.unit === 'kg', barcodes: [barcode] });
      onCreated({ id: p.id, name: p.name, barcode: barcode!, unit: p.unit });
      setF({ name: '', unit: 'piece' });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!barcode} onClose={onClose} title={tp('quickCreate')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!f.name || !can('products.manage')} onClick={create}>{tc('create')}</Button></>}>
      <p className="mb-3 text-sm text-muted">{tp('unknownBarcode')} <b className="font-mono">{barcode}</b></p>
      {!can('products.manage') && <p className="mb-3 text-sm text-danger">{tp('noRightToCreate')}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tc('name')}><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={tp('unit')}><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{tu(u)}</option>)}</Select></Field>
      </div>
      <p className="mt-2 text-xs text-muted">{tp('priceLater')}</p>
      <FormError error={error} />
    </Modal>
  );
}

/**
 * Lines of a stock document: scan a barcode (Enter) or search by name; the same product merges into
 * one line. `mode` decides the columns: receipts need a cost, counts need the counted quantity.
 */
export function LineEditor({ lines, onChange, mode = 'qty', readOnly }: { lines: DocLine[]; onChange: (l: DocLine[]) => void; mode?: 'qty' | 'cost' | 'count'; readOnly?: boolean }) {
  const t = useTranslations('shop.docs');
  const tc = useTranslations('common');
  const toast = useToast();
  const [scan, setScan] = useState('');
  const [unknown, setUnknown] = useState<string | null>(null);

  const add = (p: PickedProduct) => {
    const i = lines.findIndex((l) => l.product.id === p.id);
    if (i >= 0) onChange(lines.map((l, j) => (j === i ? { ...l, qty: l.qty + 1, counted: mode === 'count' ? (l.counted ?? 0) + 1 : l.counted } : l)));
    else onChange([...lines, { product: p, qty: 1, cost: null, counted: mode === 'count' ? 1 : null }]);
  };
  const byBarcode = async (code: string) => {
    if (!code.trim()) return;
    try {
      const p = await api(`/products/by-barcode/${encodeURIComponent(code.trim())}`);
      add({ id: p.id, name: p.name, barcode: code.trim(), unit: p.unit });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setUnknown(code.trim());
      else toast.error(e);
    }
    setScan('');
  };
  const patch = (i: number, p: Partial<DocLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="grid gap-2 md:grid-cols-2">
          <Input value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void byBarcode(scan); } }} placeholder={t('scanBarcode')} aria-label={t('scanBarcode')} />
          <ProductSearch onPick={add} placeholder={t('searchProduct')} />
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs text-muted"><tr><th className="px-3 py-2 text-left">{tc('name')}</th><th className="w-28 px-3 py-2 text-right">{mode === 'count' ? t('counted') : t('qty')}</th>{mode === 'cost' && <th className="w-36 px-3 py-2 text-right">{t('cost')}</th>}{!readOnly && <th className="w-10" />}</tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-muted">{t('noLines')}</td></tr>}
            {lines.map((l, i) => (
              <tr key={l.product.id} className="border-t border-border">
                <td className="px-3 py-1.5">{l.product.name}<div className="font-mono text-xs text-muted">{l.product.barcode}</div></td>
                <td className="px-3 py-1.5">{readOnly ? <span className="tabular block text-right">{mode === 'count' ? l.counted : l.qty}</span> : <Input type="number" step="0.001" min={0} className="h-8 text-right" value={(mode === 'count' ? l.counted : l.qty) ?? ''} onChange={(e) => patch(i, mode === 'count' ? { counted: e.target.value === '' ? null : Number(e.target.value) } : { qty: Number(e.target.value) })} />}</td>
                {mode === 'cost' && <td className="px-3 py-1.5">{readOnly ? <span className="tabular block text-right">{l.cost}</span> : <MoneyInput className="h-8 text-right" value={l.cost ?? null} onChange={(v) => patch(i, { cost: v })} />}</td>}
                {!readOnly && <td className="px-1"><button type="button" aria-label="remove" className="rounded p-1 text-muted hover:bg-surface-2" onClick={() => onChange(lines.filter((_, j) => j !== i))}>✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <QuickProductModal barcode={unknown} onClose={() => setUnknown(null)} onCreated={(p) => { add(p); setUnknown(null); }} />
    </div>
  );
}
