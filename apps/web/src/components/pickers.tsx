'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api, apiPage, qs } from '@/lib/api';
import { Input, Select } from './ui';

export interface PickedProduct { id: string; name: string; barcode?: string; unit?: string }

/** Search-as-you-type product search (name, SKU or barcode) returning a single chosen product. */
export function ProductSearch({ onPick, placeholder, autoFocus }: { onPick: (p: PickedProduct) => void; placeholder?: string; autoFocus?: boolean }) {
  const tc = useTranslations('common');
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['product-search', q], queryFn: () => apiPage<any>('/products' + qs({ q, limit: 8, active: 'true' })), enabled: q.trim().length >= 1 });
  return (
    <div className="relative">
      <Input autoFocus={autoFocus} value={q} placeholder={placeholder ?? tc('search')} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && data?.data.length) { e.preventDefault(); const p = data.data[0]; onPick({ id: p.id, name: p.name, barcode: p.barcodes?.[0], unit: p.unit }); setQ(''); } }} />
      {q && data && data.data.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {data.data.map((p: any) => (
            <li key={p.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => { onPick({ id: p.id, name: p.name, barcode: p.barcodes?.[0], unit: p.unit }); setQ(''); }}><span>{p.name}</span><span className="font-mono text-xs text-muted">{p.barcodes?.[0]}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Chips of chosen products plus a search box (promotions, labels). */
export function ProductMultiPicker({ value, onChange }: { value: PickedProduct[]; onChange: (v: PickedProduct[]) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.map((p) => <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs">{p.name}<button type="button" aria-label="remove" onClick={() => onChange(value.filter((x) => x.id !== p.id))}>✕</button></span>)}
      </div>
      <ProductSearch onPick={(p) => !value.some((x) => x.id === p.id) && onChange([...value, p])} />
    </div>
  );
}

export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: () => api<any[]>('/branches') });
}
export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('/categories') });
}

export function BranchSelect({ value, onChange, all, className }: { value: string; onChange: (v: string) => void; all?: boolean; className?: string }) {
  const tc = useTranslations('common');
  const { data } = useBranches();
  // Without an "all" option the browser shows the first branch; keep the value in step with it.
  const first = data?.[0]?.id;
  useEffect(() => {
    if (!all && !value && first) onChange(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, value, first]);
  return (
    <Select className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {all && <option value="">{tc('branch')}: {tc('all')}</option>}
      {data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
    </Select>
  );
}
