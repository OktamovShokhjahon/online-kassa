'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button, Checkbox, DataTable, Field, Input, PageHeader, Pagination, Select, useToast } from '@/components/ui';
import { BranchSelect } from '@/components/pickers';
import { api, apiPage, download, qs } from '@/lib/api';
import { daysAgo, fmtDateTime, today, useMoney } from '@/lib/format';

/** Per-report extra filters (spec 11.2). */
const EXTRA: Record<string, Array<{ key: string; type: 'number' | 'date' | 'select' | 'checkbox'; options?: string[]; defaultValue?: string }>> = {
  'slow-moving': [{ key: 'days', type: 'number', defaultValue: '30' }],
  purchases: [{ key: 'groupBy', type: 'select', options: ['document', 'supplier', 'product'], defaultValue: 'document' }],
  stock: [{ key: 'date', type: 'date' }],
  prices: [{ key: 'missingOnly', type: 'checkbox' }],
};
/** Reports that are a snapshot of "now" and need no period. */
const NO_PERIOD = new Set(['stock', 'negative-stock', 'prices', 'suppliers', 'customer-debts', 'slow-moving']);

export default function ReportsPage() {
  const t = useTranslations('shop.reports');
  const tc = useTranslations('common');
  const toast = useToast();
  const { currency, m } = useMoney();
  const list = useQuery({ queryKey: ['report-list'], queryFn: () => api<Array<{ key: string; title: string }>>('/reports') });
  const [key, setKey] = useState('');
  const [f, setF] = useState<Record<string, string>>({ from: daysAgo(29), to: today(), branchId: '' });
  const [page, setPage] = useState(1);
  useEffect(() => { if (!key && list.data?.length) setKey(list.data[0].key); }, [list.data, key]);
  useEffect(() => { setPage(1); const d = Object.fromEntries((EXTRA[key] ?? []).filter((x) => x.defaultValue).map((x) => [x.key, x.defaultValue!])); setF((s) => ({ from: s.from, to: s.to, branchId: s.branchId, ...d })); }, [key]);

  const params = { ...f, page, limit: 100 };
  const rep = useQuery({ queryKey: ['report', key, params], queryFn: () => apiPage<any>(`/reports/${key}` + qs(params)).then(async (r) => ({ ...r, raw: r })), enabled: !!key });
  const body: any = rep.data;
  // apiPage drops the envelope: the report payload is in `data`
  const report = body?.data as any;

  const fmt = (col: any, v: any) => {
    if (v === null || v === undefined || v === '') return '';
    if (col.type === 'money') return m(v);
    if (col.type === 'percent') return `${v}%`;
    if (col.type === 'datetime') return fmtDateTime(v);
    if (col.type === 'number') return typeof v === 'number' ? String(v) : v;
    return String(v);
  };
  const exportTo = (format: 'xlsx' | 'pdf') => download(`/reports/${key}` + qs({ ...f, format }), `${key}-${f.from}_${f.to}.${format}`).catch(toast.error);

  return (
    <>
      <PageHeader title={t('title')} subtitle={`${t('currencyNote')}: ${currency}`} actions={<><Button variant="secondary" onClick={() => exportTo('xlsx')}>Excel</Button><Button variant="secondary" onClick={() => exportTo('pdf')}>PDF</Button></>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('report')}><Select className="w-64" value={key} onChange={(e) => setKey(e.target.value)}>{list.data?.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</Select></Field>
        {!NO_PERIOD.has(key) && <><Field label={tc('from')}><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label={tc('to')}><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></>}
        <Field label={tc('branch')}><BranchSelect all className="w-44" value={f.branchId} onChange={(v) => setF({ ...f, branchId: v })} /></Field>
        {(EXTRA[key] ?? []).map((x) => (
          <Field key={x.key} label={t(`filter.${x.key}`)}>
            {x.type === 'select' ? <Select className="w-40" value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}>{x.options!.map((o) => <option key={o} value={o}>{t(`opt.${o}`)}</option>)}</Select>
              : x.type === 'checkbox' ? <Checkbox checked={f[x.key] === 'true'} onChange={(e) => setF({ ...f, [x.key]: e.target.checked ? 'true' : '' })} label={t(`filter.${x.key}`)} />
              : <Input className="w-36" type={x.type} value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })} />}
          </Field>
        ))}
      </div>
      {report && (
        <>
          <DataTable
            loading={rep.isLoading}
            rows={report.rows}
            rowKey={(_: any, i: number) => String(i)}
            columns={report.columns.map((c: any, i: number) => ({ key: c.key, header: c.title, align: ['money', 'number', 'percent'].includes(c.type) ? 'right' : 'left', render: (r: any) => (i === 0 && c.type === 'text' ? <span className="font-medium">{fmt(c, r[c.key])}</span> : fmt(c, r[c.key])) }))}
            footer={report.totals && <tr>{report.columns.map((c: any, i: number) => <td key={c.key} className={`px-3 py-2 ${['money', 'number', 'percent'].includes(c.type) ? 'tabular text-right' : ''}`}>{i === 0 ? tc('total') : report.totals[c.key] !== undefined ? fmt(c, report.totals[c.key]) : ''}</td>)}</tr>}
          />
          {report.note && <p className="mt-2 text-xs text-muted">{report.note}</p>}
          {rep.data && <Pagination page={body.meta.page} limit={body.meta.limit} total={body.meta.total} onPage={setPage} />}
        </>
      )}
    </>
  );
}
