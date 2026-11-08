'use client';

import { useQuery } from '@tanstack/react-query';
import { inventoryEnabled } from '@kass/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Icon } from '@/components/icons';
import { Card, DataTable, PageHeader, Select, Skeleton, Stat } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useMoney } from '@/lib/format';

/* chart colours come from the theme tokens, so they follow light/dark without a re-render */
const C = {
  primary: 'rgb(var(--primary))',
  accent: 'rgb(var(--accent))',
  success: 'rgb(var(--success))',
  grid: 'rgb(var(--border))',
  tick: { fontSize: 11, fill: 'rgb(var(--muted))' },
  pie: ['rgb(var(--primary))', 'rgb(var(--accent))', 'rgb(var(--success))', 'rgb(var(--danger))', '#8b7cf6', '#4aa3df'],
};
const tooltip = {
  contentStyle: { background: 'rgb(var(--surface))', border: '1px solid rgb(var(--border))', borderRadius: 12, boxShadow: 'var(--shadow-md)', fontSize: 12, color: 'rgb(var(--fg))', padding: '8px 12px' },
  labelStyle: { color: 'rgb(var(--muted))', marginBottom: 2 },
  itemStyle: { color: 'rgb(var(--fg))' },
  cursor: { fill: 'rgb(var(--primary) / 0.08)', stroke: 'rgb(var(--primary) / 0.3)' },
};

function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return <span className="text-muted">—</span>;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium ${pct >= 0 ? 'text-success' : 'text-danger'}`}>
      <Icon name={pct >= 0 ? 'arrowUp' : 'arrowDown'} className="h-3 w-3" strokeWidth={2.4} />{Math.abs(pct)}%
    </span>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mb-5 h-8 w-48" />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Skeleton className="col-span-2 h-44 rounded-xl" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      <div className="grid gap-4 xl:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
    </div>
  );
}

export default function ShopDashboard() {
  const t = useTranslations('shop');
  const td = useTranslations('shop.dash');
  const tc = useTranslations('common');
  const tr = useTranslations('receipt');
  const router = useRouter();
  const { can, user } = useAuth();
  const { m } = useMoney();
  const [period, setPeriod] = useState('day');
  const allowed = can('reports.view');
  const inventory = inventoryEnabled();
  useEffect(() => { if (user && !allowed) router.replace(inventoryEnabled() ? '/shop/stock' : '/shop/products'); }, [user, allowed, router]);
  const { data } = useQuery({ queryKey: ['dashboard', period], queryFn: () => api('/reports/dashboard' + qs({ period })), enabled: allowed, refetchInterval: 30_000 });
  if (!data) return <DashboardSkeleton />;
  const rows = [
    { key: 'receipts', label: td('receipts'), fmt: (v: number) => String(v), icon: 'receipts' },
    { key: 'averageReceipt', label: td('average'), fmt: m, icon: 'wallet' },
    { key: 'grossProfit', label: td('profit'), fmt: m, icon: 'reports' },
  ] as const;
  const weekdays = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ d: td(`wd${d}`), revenue: data.byWeekday.find((x: any) => x.weekday === d)?.revenue ?? 0 }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ h: `${h}`, revenue: data.byHour.find((x: any) => x.hour === h)?.revenue ?? 0 }));
  // axis values are minor units; show whole units in a compact form (2.8M, 450k)
  const fmtAxis = (v: number) => { const x = Math.abs(v) / 100; const sign = v < 0 ? '-' : ''; return x >= 1e6 ? sign + (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : x >= 1e3 ? sign + Math.round(x / 1e3) + 'k' : sign + Math.round(x); };
  const sub = (key: 'revenue' | 'receipts' | 'averageReceipt' | 'grossProfit') => (
    <span>{td('vsYesterday')} <Delta now={data.today[key]} before={data.yesterday[key]} /> · {td('vsWeek')} <Delta now={data.today[key]} before={data.sameDayLastWeek[key]} /></span>
  );
  const axis = { tickLine: false, axisLine: false, tick: C.tick } as const;
  const grid = <CartesianGrid stroke={C.grid} strokeDasharray="3 6" vertical={false} />;

  return (
    <>
      <PageHeader title={t('nav.dashboard')} actions={<Select className="w-36" value={period} onChange={(e) => setPeriod(e.target.value)}>{['day', 'week', 'month'].map((p) => <option key={p} value={p}>{td(`by_${p}`)}</option>)}</Select>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="col-span-2">
          <Stat hero icon="wallet" label={td('revenue')} num={data.today.revenue} fmt={m} spark={data.chart.map((p: any) => p.revenue)} sub={sub('revenue')} />
        </div>
        {rows.map((r, i) => (
          <div key={r.key} className={i === 2 ? 'col-span-2 lg:col-span-1' : ''}>
            <Stat icon={r.icon} label={r.label} num={data.today[r.key]} fmt={r.fmt} sub={sub(r.key)} delay={90 * (i + 1)} />
          </div>
        ))}
      </div>

      <div className={`mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 ${inventory ? '2xl:grid-cols-7' : ''}`}>
        <Stat icon="wallet" label={td('openShifts')} num={data.live.openShifts} delay={300} />
        <Stat icon="terminals" label={td('onlineTerminals')} num={data.live.onlineTerminals} delay={340} />
        <Stat icon="cloud" label={td('unsentOffline')} num={data.live.unsentOfflineReceipts} tone={data.live.unsentOfflineReceipts ? 'warn' : undefined} delay={380} />
        {inventory && <Stat icon="box" label={td('lowStock')} num={data.live.lowStock} tone={data.live.lowStock ? 'warn' : undefined} delay={420} />}
        {inventory && <Stat icon="alert" label={td('negativeStock')} num={data.live.negativeStock} tone={data.live.negativeStock ? 'danger' : undefined} delay={460} />}
        {inventory && <Stat icon="suppliers" label={td('supplierDebt')} num={data.live.supplierDebt} fmt={m} delay={500} />}
        <Stat icon="customers" label={td('customerDebt')} num={data.live.customerDebt} fmt={m} delay={540} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={td('revenueChart')}>
          <div className="h-64">
            <ResponsiveContainer>
              <AreaChart data={data.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={C.primary} stopOpacity={0.35} /><stop offset="1" stopColor={C.primary} stopOpacity={0} /></linearGradient>
                </defs>
                {grid}<XAxis dataKey="bucket" {...axis} /><YAxis tickFormatter={fmtAxis} width={46} {...axis} />
                <Tooltip formatter={(v: number) => m(v)} {...tooltip} />
                <Area type="monotone" dataKey="revenue" name={td('revenue')} stroke={C.primary} strokeWidth={2.5} fill="url(#revFill)" dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'rgb(var(--surface))' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={td('byHour')}>
          <div className="h-64"><ResponsiveContainer><BarChart data={hours} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>{grid}<XAxis dataKey="h" {...axis} /><YAxis tickFormatter={fmtAxis} width={46} {...axis} /><Tooltip formatter={(v: number) => m(v)} {...tooltip} /><Bar dataKey="revenue" name={td('revenue')} fill={C.primary} radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </Card>
        <Card title={td('byWeekday')}>
          <div className="h-64"><ResponsiveContainer><BarChart data={weekdays} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>{grid}<XAxis dataKey="d" {...axis} /><YAxis tickFormatter={fmtAxis} width={46} {...axis} /><Tooltip formatter={(v: number) => m(v)} {...tooltip} /><Bar dataKey="revenue" name={td('revenue')} fill={C.accent} radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </Card>
        <Card title={td('paymentSplit')}>
          <div className="h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={data.paymentSplit.map((p: any) => ({ name: tr(p.method), value: p.amount }))} dataKey="value" nameKey="name" innerRadius={52} outerRadius={88} paddingAngle={3} cornerRadius={5} stroke="rgb(var(--surface))" strokeWidth={2} label={({ percent }: any) => `${Math.round((percent ?? 0) * 100)}%`}>
                  {data.paymentSplit.map((_: any, i: number) => <Cell key={i} fill={C.pie[i % C.pie.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => m(v)} {...tooltip} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: 'rgb(var(--muted))' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title={td('topByRevenue')}>
          <DataTable rows={data.topProductsByRevenue} columns={[{ key: 'name', header: tc('name') }, { key: 'quantity', header: td('qty'), align: 'right' }, { key: 'revenue', header: td('revenue'), align: 'right', render: (r: any) => m(r.revenue) }]} />
        </Card>
        <Card title={td('topByQuantity')}>
          <DataTable rows={data.topProductsByQuantity} columns={[{ key: 'name', header: tc('name') }, { key: 'quantity', header: td('qty'), align: 'right' }, { key: 'revenue', header: td('revenue'), align: 'right', render: (r: any) => m(r.revenue) }]} />
        </Card>
        <Card title={td('topCategories')}>
          <DataTable rows={data.topCategories} rowKey={(r: any) => r.name} columns={[{ key: 'name', header: tc('name') }, { key: 'revenue', header: td('revenue'), align: 'right', render: (r: any) => m(r.revenue) }]} />
        </Card>
        <Card title={td('branchComparison')}>
          <DataTable rows={data.branchComparison} columns={[{ key: 'name', header: tc('branch') }, { key: 'receipts', header: td('receipts'), align: 'right' }, { key: 'revenue', header: td('revenue'), align: 'right', render: (r: any) => m(r.revenue) }]} />
        </Card>
      </div>
    </>
  );
}
