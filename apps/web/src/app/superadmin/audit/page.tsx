'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { DataTable, Input, PageHeader, Pagination } from '@/components/ui';
import { apiPage, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

export default function PlatformAuditPage() {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const [f, setF] = useState({ action: '', page: 1 });
  const { data, isLoading } = useQuery({ queryKey: ['sa-audit', f], queryFn: () => apiPage('/admin/audit-logs' + qs({ ...f, limit: 30 })) });
  return (
    <>
      <PageHeader title={t('nav.audit')} />
      <Input className="mb-3 w-72" placeholder={t('audit.actionFilter')} value={f.action} onChange={(e) => setF({ action: e.target.value, page: 1 })} />
      <DataTable
        loading={isLoading}
        rows={data?.data}
        columns={[
          { key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) },
          { key: 'action', header: t('audit.action'), render: (r: any) => <code className="text-xs">{r.action}</code> },
          { key: 'userName', header: t('audit.user') },
          { key: 'entityId', header: t('audit.entity'), render: (r: any) => <span className="font-mono text-xs">{r.entity} {r.entityId}</span> },
          { key: 'meta', header: tc('comment'), render: (r: any) => <span className="text-xs text-muted">{r.meta ? JSON.stringify(r.meta).slice(0, 80) : ''}</span> },
          { key: 'ip', header: 'IP' },
        ]}
      />
      {data && <Pagination page={data.meta.page} limit={data.meta.limit} total={data.meta.total} onPage={(page) => setF({ ...f, page })} />}
    </>
  );
}
