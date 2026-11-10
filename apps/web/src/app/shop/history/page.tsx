'use client';

import { useQuery } from '@tanstack/react-query';
import { HISTORY_TYPES, type HistoryType } from '@kass/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { BranchSelect } from '@/components/pickers';
import { Badge, Button, Card, DataTable, Field, Input, Modal, PageHeader, Pagination, Select, cx } from '@/components/ui';
import { api, apiPage, qs } from '@/lib/api';
import { daysAgo, fmtDateTime, today, useMoney } from '@/lib/format';

type Period = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'all' | 'custom';
const dayStart = (d: string) => new Date(`${d}T00:00:00+05:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999+05:00`).toISOString();

function periodRange(p: Period, custom: { from: string; to: string }): { from?: string; to?: string } {
  switch (p) {
    case 'today': return { from: dayStart(today()) };
    case 'yesterday': return { from: dayStart(daysAgo(1)), to: dayEnd(daysAgo(1)) };
    case '7d': return { from: dayStart(daysAgo(6)) };
    case '30d': return { from: dayStart(daysAgo(29)) };
    case 'month': return { from: dayStart(today().slice(0, 8) + '01') };
    case 'custom': return { from: custom.from ? dayStart(custom.from) : undefined, to: custom.to ? dayEnd(custom.to) : undefined };
    default: return {};
  }
}

const qtyFmt = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('ru-RU');
const TONE: Record<HistoryType, 'success' | 'danger' | 'warn' | 'info' | 'neutral'> = { sale: 'success', declined: 'danger', refund: 'warn', arrival: 'info', shift: 'neutral', cash: 'neutral' };

export default function HistoryPage() {
  const t = useTranslations('shop.history');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const [type, setType] = useState<HistoryType | ''>('');
  const [period, setPeriod] = useState<Period>('today');
  const [custom, setCustom] = useState({ from: today(), to: today() });
  const [branchId, setBranchId] = useState('');
  const [terminalId, setTerminalId] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const { data: terminals } = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/terminals') });

  useEffect(() => { const id = setTimeout(() => setSearch(q.trim()), 350); return () => clearTimeout(id); }, [q]);
  useEffect(() => setPage(1), [type, period, custom, branchId, terminalId, search]);

  const range = periodRange(period, custom);
  const params = { ...range, type: type || undefined, branchId: branchId || undefined, terminalId: terminalId || undefined, q: search || undefined };
  const { data, isLoading } = useQuery({
    queryKey: ['history', page, params],
    queryFn: () => apiPage<any>('/history' + qs({ page, limit: 25, ...params })),
    refetchInterval: 30_000,
  });
  const summary = (data?.meta as any)?.summary as Record<HistoryType, { count: number; amount: number }> | undefined;
  const termOptions = (terminals ?? []).filter((x) => !branchId || x.branchId === branchId);

  const status = (r: any) => {
    if (r.type === 'declined') return r.kind === 'rejected' ? t('rejected', { code: r.note ?? '' }) : t('cleared');
    if (r.type === 'shift') return t(`shift_${r.kind}`);
    if (r.type === 'cash') return t(`cash_${r.kind}`);
    if (r.type === 'refund') return r.status ? t('ofSale', { n: r.status }) : '';
    return r.kind ? t(`status.${r.kind}`) : '';
  };
  const details = (r: any) => {
    const items = (r.items ?? []) as Array<{ name: string; qty: number }>;
    const head = items.slice(0, 3).map((x) => `${x.name} × ${qtyFmt(x.qty)}`).join(', ');
    const more = items.length > 3 ? ` ${t('more', { n: items.length - 3 })}` : '';
    if (r.type === 'arrival') return `${r.supplierName ? t('fromSupplier', { name: r.supplierName }) : t('noSupplier')}${head ? ': ' + head : ''}${more}`;
    if (r.type === 'shift' || r.type === 'cash') return [r.cashierName, r.note && r.note !== 'auto' ? r.note : r.note === 'auto' ? t('autoShift') : ''].filter(Boolean).join(' · ');
    return head + more;
  };
  const signed = (r: any) => (r.type === 'refund' || (r.type === 'cash' && r.kind === 'out') ? -r.amount : r.amount);

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {/* type chips with counts for the chosen period */}
      <div className="mb-3 flex flex-wrap gap-2">
        {(['', ...HISTORY_TYPES] as const).map((k) => {
          const s = k ? summary?.[k] : undefined;
          const total = !k && summary ? Object.values(summary).reduce((a, b) => a + b.count, 0) : s?.count;
          return (
            <button
              key={k || 'all'}
              type="button"
              onClick={() => setType(k)}
              className={cx('rounded-full border px-3.5 py-1.5 text-sm transition', type === k ? 'border-primary bg-primary text-primary-fg shadow-sm' : 'border-border bg-surface hover:bg-surface-2')}
            >
              {k ? t(`types.${k}`) : t('all')}
              {total !== undefined && <span className={cx('ml-1.5 tabular text-xs', type === k ? 'opacity-80' : 'text-muted')}>{total}</span>}
            </button>
          );
        })}
      </div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field help={false} label={t('period')} className="w-44">
            <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {(['today', 'yesterday', '7d', '30d', 'month', 'all', 'custom'] as const).map((p) => <option key={p} value={p}>{t(`periods.${p}`)}</option>)}
            </Select>
          </Field>
          {period === 'custom' && <>
            <Field help={false} label={tc('from')} className="w-40"><Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></Field>
            <Field help={false} label={tc('to')} className="w-40"><Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></Field>
          </>}
          <Field help={false} label={tc('branch')} className="w-48"><BranchSelect all value={branchId} onChange={(v) => { setBranchId(v); setTerminalId(''); }} /></Field>
          <Field help={false} label={t('terminal')} className="w-44">
            <Select value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
              <option value="">{t('allTerminals')}</option>
              {termOptions.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          <Field help={false} label={tc('search')} className="min-w-[14rem] flex-1"><Input value={q} placeholder={t('searchHint')} onChange={(e) => setQ(e.target.value)} /></Field>
        </div>
      </Card>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SumTile label={t('types.sale')} count={summary.sale.count} amount={m(summary.sale.amount)} tone="success" />
          <SumTile label={t('types.declined')} count={summary.declined.count} amount={m(summary.declined.amount)} tone="danger" />
          <SumTile label={t('types.refund')} count={summary.refund.count} amount={m(summary.refund.amount)} tone="warn" />
          <SumTile label={t('types.arrival')} count={summary.arrival.count} amount={m(summary.arrival.amount)} tone="info" />
        </div>
      )}

      <Card>
        <DataTable
          rows={data?.data ?? []}
          loading={isLoading}
          rowKey={(r: any) => r.id}
          onRowClick={(r: any) => setOpen(r)}
          columns={[
            { key: 'at', header: t('time'), render: (r: any) => <span className="whitespace-nowrap">{fmtDateTime(r.at)}</span> },
            { key: 'type', header: t('type'), render: (r: any) => <Badge tone={TONE[r.type as HistoryType]} dot>{t(`types.${r.type}`)}</Badge> },
            { key: 'number', header: t('number'), render: (r: any) => <span className="font-mono text-xs">{r.number ?? ''}{r.isOffline && <span className="ml-1 text-muted">({t('offline')})</span>}</span> },
            { key: 'details', header: t('details'), render: (r: any) => <span className="line-clamp-2 text-sm">{details(r)}</span> },
            { key: 'where', header: t('where'), render: (r: any) => <span className="text-xs text-muted">{[r.terminalName ?? r.branchName, r.type === 'sale' || r.type === 'declined' ? r.cashierName : ''].filter(Boolean).join(' · ')}</span> },
            { key: 'status', header: t('status.title'), render: (r: any) => <span className={cx('text-xs', r.type === 'declined' && 'text-danger', r.kind === 'cancelled' && 'text-danger')}>{status(r)}</span> },
            { key: 'amount', header: tc('amount'), align: 'right', render: (r: any) => (r.type === 'shift' && !r.amount ? '' : <b className={cx('tabular whitespace-nowrap', signed(r) < 0 && 'text-danger', r.type === 'declined' && 'text-muted line-through')}>{m(signed(r))}</b>) },
          ]}
        />
        {data && <Pagination page={page} limit={25} total={data.meta?.total ?? 0} onPage={setPage} />}
      </Card>

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${t(`types.${open.type}`)} ${open.number ?? ''}` : ''} footer={<Button onClick={() => setOpen(null)}>{tc('close')}</Button>}>
        {open && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted">
              <span>{fmtDateTime(open.at)}</span>
              {open.branchName && <span>{open.branchName}</span>}
              {open.terminalName && <span>{open.terminalName}</span>}
              {open.cashierName && <span>{open.cashierName}</span>}
            </div>
            <div><Badge tone={TONE[open.type as HistoryType]}>{status(open) || t(`types.${open.type}`)}</Badge></div>
            {open.items?.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {open.items.map((x: any, i: number) => <li key={i} className="flex justify-between px-3 py-2"><span>{x.name}</span><span className="tabular text-muted">× {qtyFmt(x.qty)}</span></li>)}
              </ul>
            )}
            {open.type === 'arrival' && <p className="text-muted">{open.supplierName ? t('fromSupplier', { name: open.supplierName }) : t('noSupplier')}</p>}
            {open.note && open.type !== 'declined' && open.note !== 'auto' && <p className="text-muted">{open.note}</p>}
            {open.method && <p className="text-muted">{t('method')}: {t(`methods.${open.method}`)}</p>}
            {!(open.type === 'shift' && !open.amount) && <p className="text-right text-lg font-semibold">{m(signed(open))}</p>}
          </div>
        )}
      </Modal>
    </>
  );
}

function SumTile({ label, count, amount, tone }: { label: string; count: number; amount: string; tone: 'success' | 'danger' | 'warn' | 'info' }) {
  const bar = { success: 'bg-success', danger: 'bg-danger', warn: 'bg-warn', info: 'bg-primary' }[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface p-4 shadow-sm">
      <span className={cx('absolute inset-y-0 left-0 w-1', bar)} />
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="tabular text-xl font-semibold">{count}</span>
        <span className="tabular truncate text-sm text-muted">{amount}</span>
      </div>
    </div>
  );
}
