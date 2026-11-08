'use client';

import { useTranslations } from 'next-intl';
import { CrudPage } from '@/components/crud';
import { useBranches } from '@/components/pickers';
import { Badge } from '@/components/ui';

export default function BranchesPage() {
  const t = useTranslations('shop.branches');
  const tc = useTranslations('common');
  const { data: branches } = useBranches();
  return (
    <CrudPage<any>
      title={t('title')}
      endpoint="/branches"
      queryKey="branches-list"
      searchable={false}
      emptyForm={{ name: '', address: '', phone: '', workingHours: '', receiptHeader: '', receiptFooter: '', isActive: true, copyPricesFromBranchId: '' }}
      fromRow={(r) => ({ name: r.name, address: r.address ?? '', phone: r.phone ?? '', workingHours: r.workingHours ?? '', receiptHeader: r.receiptHeader ?? '', receiptFooter: r.receiptFooter ?? '', isActive: r.isActive })}
      toBody={(f, creating) => ({ name: f.name, address: f.address || undefined, phone: f.phone || undefined, workingHours: f.workingHours || undefined, receiptHeader: f.receiptHeader || undefined, receiptFooter: f.receiptFooter || undefined, isActive: f.isActive, ...(creating && f.copyPricesFromBranchId ? { copyPricesFromBranchId: f.copyPricesFromBranchId } : {}) })}
      fields={[
        { key: 'name', label: tc('name'), required: true },
        { key: 'phone', label: tc('phone'), type: 'tel' },
        { key: 'address', label: t('address'), span: 2 },
        { key: 'workingHours', label: t('hours') },
        { key: 'isActive', label: tc('active'), type: 'checkbox' },
        { key: 'receiptHeader', label: t('receiptHeader'), span: 2 },
        { key: 'receiptFooter', label: t('receiptFooter'), span: 2 },
        { key: 'copyPricesFromBranchId', label: t('copyPrices'), type: 'select', createOnly: true, hint: t('copyPricesHint'), options: branches?.map((b) => ({ value: b.id, label: b.name })) ?? [], span: 2 },
      ]}
      columns={[
        { key: 'name', header: tc('name'), render: (r) => <span className="font-medium">{r.name}</span> },
        { key: 'address', header: t('address') },
        { key: 'phone', header: tc('phone') },
        { key: 'isActive', header: tc('status'), render: (r) => (r.isActive ? <Badge tone="success">{tc('active')}</Badge> : <Badge>{tc('inactive')}</Badge>) },
      ]}
    />
  );
}
