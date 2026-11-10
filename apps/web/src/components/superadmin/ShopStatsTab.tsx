'use client';

import { useQuery } from '@tanstack/react-query';
import { formatMoney, type Currency, type Language } from '@kass/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, DataTable, Empty, Field, Select, Skeleton, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type Period = 'today' | '7d' | '30d' | 'month' | 'all';

/** Statistics of one shop for the platform owner: sales, profit, refunds, declined receipts, goods received. */
export function ShopStatsTab({ shopId, currency }: { shopId: string; currency: Currency }) {
  const t = useTranslations('sa.stats');
  const tc = useTranslations('common');
  const tm = useTranslations('shop.history.methods');
  const lang = useLocale() as Language;
  const [period, setPeriod] = useState<Period>('30d');
  const { data, isLoading } = useQuery({ queryKey: ['sa-shop-stats', shopId, period], queryFn: () => api<any>(`/admin/shops/${shopId}/stats?period=${period}`) });
  const m = (n: number) => formatMoney(n, currency, lang);
  const fmtAxis = (v: number) => { const x = Math.abs(v) / 100; return x >= 1e6 ? (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(Math.round(x)); };
  const axis = { tickLine: false, axisLine: false, tick: { fontSize: 11, fill: 'rgb(var(--muted))' } } as const;
  const delta = (now: number, before?: number) => {
    if (before === undefined || before === null) return null;
    if (!before) return now ? <span className="text-success">+100%</span> : null;
    const p = Math.round(((now - before) / before) * 100);
    return <span className={p >= 0 ? 'text-success' : 'text-danger'}>{p >= 0 ? '+' : ''}{p}%</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t('period')} className="w-48">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {(['today', '7d', '30d', 'month', 'all'] as const).map((p) => <option key={p} value={p}>{t(`periods.${p}`)}</option>)}
          </Select>
        </Field>
        {data && <p className="text-sm text-muted">{t('lastSale')}: <b className="text-fg">{data.lastSaleAt ? fmtDateTime(data.lastSaleAt) : t('never')}</b></p>}
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat hero icon="wallet" label={t('revenue')} num={data.totals.revenue} fmt={m} spark={data.byDay.map((d: any) => d.revenue)} sub={data.previous && <span>{t('vsPrevious')} {delta(data.totals.revenue, data.previous.revenue)}</span>} />
            <Stat icon="receipts" label={t('receipts')} num={data.totals.receipts} sub={data.previous && <span>{t('vsPrevious')} {delta(data.totals.receipts, data.previous.receipts)}</span>} delay={60} />
            <Stat icon="reports" label={t('profit')} num={data.totals.grossProfit} fmt={m} tone={data.totals.grossProfit < 0 ? 'danger' : 'success'} delay={120} />
            <Stat icon="prices" label={t('average')} num={data.totals.averageReceipt} fmt={m} delay={180} />
            <Stat icon="writeoffs" label={t('refunds')} value={m(data.totals.refunds.total)} sub={t('count', { n: data.totals.refunds.count })} tone={data.totals.refunds.count ? 'warn' : undefined} delay={220} />
            <Stat icon="alert" label={t('declined')} value={data.totals.declined.cleared.count + data.totals.declined.rejected.count} sub={t('declinedSplit', { cleared: data.totals.declined.cleared.count, rejected: data.totals.declined.rejected.count })} tone={data.totals.declined.rejected.count ? 'danger' : undefined} delay={260} />
            <Stat icon="warehouse" label={t('arrivals')} value={m(data.totals.arrivals.total)} sub={t('count', { n: data.totals.arrivals.count })} delay={300} />
            <Stat icon="products" label={t('discount')} value={m(data.totals.discount)} sub={t('countsLine', { p: data.counts.products, e: data.counts.employees, b: data.counts.branches, k: data.counts.terminals })} delay={340} />
          </div>

          <Card title={t('byDay')}>
            {data.byDay.length ? (
              <div className="h-64">
                <ResponsiveContainer>
                  <AreaChart data={data.byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="saRev" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="rgb(var(--primary))" stopOpacity={0.35} /><stop offset="1" stopColor="rgb(var(--primary))" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 6" vertical={false} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5).split('-').reverse().join('.')} {...axis} />
                    <YAxis tickFormatter={fmtAxis} width={46} {...axis} />
                    <Tooltip formatter={(v: number) => m(v)} labelFormatter={(d: string) => d.split('-').reverse().join('.')} contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--border))', borderRadius: 12, fontSize: 12, color: 'rgb(var(--fg))' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: 'rgb(var(--muted))' }} />
                    <Area type="monotone" dataKey="revenue" name={t('revenue')} stroke="rgb(var(--primary))" strokeWidth={2.5} fill="url(#saRev)" dot={false} />
                    <Area type="monotone" dataKey="profit" name={t('profit')} stroke="rgb(var(--accent))" strokeWidth={2} fill="none" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <Empty>{t('noSales')}</Empty>}
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={t('topProducts')}>
              <DataTable rows={data.topProducts} rowKey={(r: any) => r.name} columns={[
                { key: 'name', header: tc('name') },
                { key: 'qty', header: t('qty'), align: 'right', render: (r: any) => (Math.round(r.qty * 1000) / 1000).toLocaleString('ru-RU') },
                { key: 'revenue', header: t('revenue'), align: 'right', render: (r: any) => <b>{m(r.revenue)}</b> },
              ]} />
            </Card>
            <Card title={t('byTerminal')}>
              <DataTable rows={data.byTerminal} rowKey={(r: any) => r.terminalId} columns={[
                { key: 'name', header: t('terminal') },
                { key: 'receipts', header: t('receipts'), align: 'right' },
                { key: 'revenue', header: t('revenue'), align: 'right', render: (r: any) => <b>{m(r.revenue)}</b> },
              ]} />
            </Card>
            <Card title={t('byCashier')}>
              <DataTable rows={data.byCashier} rowKey={(r: any, i?: number) => `${r.name}${i}`} columns={[
                { key: 'name', header: t('cashier') },
                { key: 'receipts', header: t('receipts'), align: 'right' },
                { key: 'revenue', header: t('revenue'), align: 'right', render: (r: any) => <b>{m(r.revenue)}</b> },
              ]} />
            </Card>
            <Card title={t('payments')}>
              {data.payments.length ? (
                <ul className="space-y-2">
                  {data.payments.map((p: any) => {
                    const total = data.payments.reduce((s: number, x: any) => s + x.amount, 0) || 1;
                    const pct = Math.round((p.amount / total) * 100);
                    return (
                      <li key={p.method}>
                        <div className="mb-1 flex justify-between text-sm"><span>{tm(p.method)}</span><span className="tabular"><b>{m(p.amount)}</b> <span className="text-muted">· {pct}%</span></span></div>
                        <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                      </li>
                    );
                  })}
                </ul>
              ) : <Empty>{t('noSales')}</Empty>}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
