'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, DataTable, Input, PageHeader, Pagination, Select } from '@/components/ui';
import { apiPage, qs } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';

const TONE = { active: 'success', trial: 'info', expired: 'danger', blocked: 'danger' } as const;

export default function ShopsPage() {
  const t = useTranslations('sa');
  const ts = useTranslations('shopStatus');
  const tc = useTranslations('common');
  const router = useRouter();
  const [f, setF] = useState({ q: '', status: '', fiscal: '', page: 1 });
  const { data, isLoading } = useQuery({ queryKey: ['sa-shops', f], queryFn: () => apiPage('/admin/shops' + qs({ ...f, limit: 20 })) });

  return (
    <>
      <PageHeader title={t('nav.shops')} actions={<Link href="/superadmin/shops/new"><Button>{t('shop.create')}</Button></Link>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="w-64" placeholder={tc('search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
        <Select className="w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}>
          <option value="">{tc('status')}: {tc('all')}</option>
          {(['active', 'trial', 'expired', 'blocked'] as const).map((s) => <option key={s} value={s}>{ts(s)}</option>)}
        </Select>
        <Select className="w-44" value={f.fiscal} onChange={(e) => setF({ ...f, fiscal: e.target.value, page: 1 })}>
          <option value="">{t('shop.fiscal')}: {tc('all')}</option>
          <option value="on">{t('shop.fiscal')}: {tc('yes')}</option>
          <option value="off">{t('shop.fiscal')}: {tc('no')}</option>
        </Select>
      </div>
      <DataTable
        loading={isLoading}
        rows={data?.data}
        onRowClick={(r: any) => router.push(`/superadmin/shops/${r.id}`)}
        columns={[
          { key: 'name', header: t('shop.name'), render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: 'admin', header: t('shop.admin'), render: (r: any) => (r.admin ? <><div>{r.admin.fullName}</div><div className="text-xs text-muted">{r.admin.login} · {r.admin.phone}</div></> : '—') },
          { key: 'status', header: t('shop.status'), render: (r: any) => <Badge tone={TONE[r.effectiveStatus as keyof typeof TONE]}>{ts(r.effectiveStatus)}</Badge> },
          { key: 'fiscal', header: t('shop.fiscal'), render: (r: any) => (r.fiscalEnabled ? <Badge tone="info">{tc('yes')}</Badge> : <span className="text-muted">{tc('no')}</span>) },
          { key: 'paidUntil', header: t('shop.paidUntil'), render: (r: any) => fmtDate(r.paidUntil) || '—' },
          { key: 'branchCount', header: t('shop.branches'), align: 'right' },
          { key: 'terminalCount', header: t('shop.terminals'), align: 'right' },
          { key: 'lastActivityAt', header: t('shop.lastActivity'), render: (r: any) => fmtDateTime(r.lastActivityAt) },
        ]}
      />
      {data && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={(page) => setF({ ...f, page })} />}
    </>
  );
}
