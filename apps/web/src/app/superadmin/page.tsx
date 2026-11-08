'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatMoney, type Currency, type Language } from '@kass/shared';
import { Card, DataTable, PageHeader, Spinner, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';

export default function SuperadminDashboard() {
  const t = useTranslations('sa');
  const ts = useTranslations('shopStatus');
  const lang = useLocale() as Language;
  const { data, isLoading } = useQuery({ queryKey: ['sa-dashboard'], queryFn: () => api('/admin/dashboard'), refetchInterval: 30_000 });
  if (isLoading || !data) return <Spinner />;
  const vol = (rows: Array<{ currency: string; volume: number; receipts: number }>) =>
    rows.length ? rows.map((r) => `${formatMoney(r.volume, r.currency as Currency, lang)} · ${r.receipts}`).join('  |  ') : '—';

  return (
    <>
      <PageHeader title={t('nav.dashboard')} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={t('dash.total')} num={data.shops.total} />
        <Stat label={ts('active')} num={data.shops.active} tone="success" />
        <Stat label={ts('trial')} num={data.shops.trial} />
        <Stat label={ts('blocked')} num={data.shops.blocked} tone={data.shops.blocked ? 'danger' : undefined} />
        <Stat label={ts('expired')} num={data.shops.expired} tone={data.shops.expired ? 'danger' : undefined} />
        <Stat label={t('dash.expiring7')} num={data.shops.expiringIn7Days} tone={data.shops.expiringIn7Days ? 'warn' : undefined} />
      </div>
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <Stat label={t('dash.terminalsOnline')} value={`${data.terminals.online} / ${data.terminals.total}`} />
        <Card title={t('dash.sales')}>
          <dl className="space-y-1 text-sm">
            {([['today', data.sales.today], ['d7', data.sales.last7Days], ['d30', data.sales.last30Days]] as const).map(([k, rows]) => (
              <div key={k} className="flex justify-between gap-4"><dt className="text-muted">{t(`dash.${k}`)}</dt><dd className="tabular text-right">{vol(rows)}</dd></div>
            ))}
          </dl>
        </Card>
      </div>
      <Card title={t('dash.attention')}>
        <DataTable
          columns={[
            { key: 'name', header: t('shop.name'), render: (r: any) => <Link className="text-primary hover:underline" href={`/superadmin/shops/${r.id}`}>{r.name}</Link> },
            { key: 'paidUntil', header: t('shop.paidUntil'), render: (r: any) => fmtDate(r.paidUntil) },
            { key: 'status', header: t('shop.status'), render: (r: any) => ts(r.status) },
          ]}
          rows={data.attention}
        />
      </Card>
    </>
  );
}
