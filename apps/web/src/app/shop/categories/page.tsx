'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { CrudPage } from '@/components/crud';
import { useCategories } from '@/components/pickers';
import { Badge, Button, ConfirmModal, useToast } from '@/components/ui';
import { del } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function CategoriesPage() {
  const t = useTranslations('shop.categories');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { data: cats } = useCategories();
  const [confirm, setConfirm] = useState<any>(null);
  const remove = useMutation({
    mutationFn: (id: string) => del(`/categories/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['categories-list'] }); qc.invalidateQueries({ queryKey: ['categories'] }); setConfirm(null); toast.ok(tc('saved')); },
    onError: (e) => { toast.error(e); setConfirm(null); },
  });
  const manage = can('categories.manage');
  return (
    <>
      <CrudPage<any>
        title={t('title')}
        endpoint="/categories"
        queryKey="categories-list"
        searchable={false}
        canWrite={manage}
        emptyForm={{ name: '', parentId: '', sortOrder: 0, isActive: true }}
        fromRow={(r) => ({ name: r.name, parentId: r.parentId ?? '', sortOrder: r.sortOrder, isActive: r.isActive })}
        toBody={(f) => ({ name: f.name, parentId: f.parentId || null, sortOrder: Number(f.sortOrder) || 0, isActive: f.isActive })}
        fields={[
          { key: 'name', label: tc('name'), required: true },
          { key: 'parentId', label: t('parent'), type: 'select', options: cats?.filter((c) => c.depth < 3).map((c) => ({ value: c.id, label: `${'— '.repeat(c.depth - 1)}${c.name}` })) ?? [], hint: t('depthHint') },
          { key: 'sortOrder', label: t('sortOrder'), type: 'number' },
          { key: 'isActive', label: tc('active'), type: 'checkbox' },
        ]}
        columns={[
          { key: 'name', header: tc('name'), render: (r) => <span style={{ paddingLeft: (r.depth - 1) * 20 }} className="font-medium">{r.depth > 1 && '↳ '}{r.name}</span> },
          { key: 'productCount', header: t('products'), align: 'right' },
          { key: 'isActive', header: tc('status'), render: (r) => (r.isActive ? <Badge tone="success">{tc('active')}</Badge> : <Badge>{tc('inactive')}</Badge>) },
        ]}
        rowActions={manage ? (r) => <Button size="sm" variant="ghost" onClick={() => setConfirm(r)}>{tc('delete')}</Button> : undefined}
      />
      <ConfirmModal open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate(confirm.id)} loading={remove.isPending} danger title={tc('delete')} message={t('deleteNote', { name: confirm?.name ?? '' })} />
    </>
  );
}
