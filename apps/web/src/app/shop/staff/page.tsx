'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { LANGUAGES, ROLE_DEFAULT_PERMISSIONS, ROLE_GRANTABLE_PERMISSIONS, STAFF_ROLES, type Language, type Role } from '@kass/shared';
import { CrudPage } from '@/components/crud';
import { useBranches } from '@/components/pickers';
import { Badge, Button, Modal, useToast } from '@/components/ui';
import { patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function StaffPage() {
  const t = useTranslations('shop.staff');
  const tc = useTranslations('common');
  const tr = useTranslations('roles');
  const tl = useTranslations('languages');
  const tp = useTranslations('shop.perm');
  const locale = useLocale() as Language;
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: branches } = useBranches();
  const isAdmin = user?.role === 'shop_admin';
  const [secret, setSecret] = useState<{ login: string; newPassword: string } | null>(null);
  const roles = isAdmin ? STAFF_ROLES : (['cashier'] as Role[]);
  const status = useMutation({ mutationFn: (r: any) => patch(`/users/${r.id}/status`, { isActive: !r.isActive }), onSuccess: () => qc.invalidateQueries({ queryKey: ['staff'] }), onError: toast.error });
  const mine = branches?.map((b) => ({ value: b.id, label: b.name })) ?? [];

  return (
    <>
      <CrudPage<any>
        title={t('title')}
        endpoint="/users"
        queryKey="staff"
        canWrite
        emptyForm={{ role: 'cashier', fullName: '', phone: '', login: '', password: '', branchIds: [], permissions: [], pin: '', language: locale }}
        fromRow={(r) => ({ role: r.role, fullName: r.fullName, phone: r.phone ?? '', branchIds: r.branchIds, permissions: r.permissions.filter((p: string) => !ROLE_DEFAULT_PERMISSIONS[r.role as Role].includes(p as never)), pin: '', language: r.language })}
        canEditRow={(r) => r.role !== 'shop_admin'}
        toBody={(f, creating) => ({
          ...(creating ? { role: f.role, login: f.login, password: f.password } : {}),
          fullName: f.fullName, phone: f.phone || undefined, branchIds: f.branchIds, permissions: f.permissions, language: f.language,
          ...(f.pin ? { pin: f.pin } : {}),
        })}
        fields={[
          { key: 'role', label: t('role'), type: 'select', required: true, createOnly: true, options: roles.map((r) => ({ value: r, label: tr(r) })) },
          { key: 'fullName', label: t('fullName'), required: true },
          { key: 'phone', label: tc('phone'), type: 'tel' },
          { key: 'login', label: t('login'), required: true, createOnly: true, autoComplete: 'off' },
          { key: 'password', label: t('password'), type: 'password', required: true, createOnly: true },
          { key: 'pin', label: t('pin'), hint: t('pinHint') },
          { key: 'language', label: tc('language'), type: 'select', required: true, options: LANGUAGES.map((l) => ({ value: l, label: tl(l) })) },
          { key: 'branchIds', label: t('branches'), type: 'multiselect', options: mine },
          { key: 'permissions', label: t('extraPermissions'), type: 'multiselect', hint: t('permNote'), show: (f) => f.role !== 'shop_admin',
            options: (f) => ROLE_GRANTABLE_PERMISSIONS[f.role as Role]?.filter((p) => !ROLE_DEFAULT_PERMISSIONS[f.role as Role].includes(p)).map((p) => ({ value: p, label: tp(p) })) ?? [] },
        ]}
        columns={[
          { key: 'fullName', header: t('fullName'), render: (r) => <div><span className="font-medium">{r.fullName}</span><div className="text-xs text-muted">{r.login} · {r.phone}</div></div> },
          { key: 'role', header: t('role'), render: (r) => tr(r.role) },
          { key: 'branchIds', header: t('branches'), render: (r) => r.branchIds.map((id: string) => branches?.find((b) => b.id === id)?.name).filter(Boolean).join(', ') },
          { key: 'isActive', header: tc('status'), render: (r) => <Badge tone={r.isActive ? 'success' : 'neutral'}>{r.isActive ? tc('active') : tc('inactive')}</Badge> },
        ]}
        rowActions={(r) => r.role === 'shop_admin' ? null : (
          <>
            <Button size="sm" variant="ghost" onClick={async () => { try { setSecret(await post(`/users/${r.id}/reset-password`)); } catch (e) { toast.error(e); } }}>{t('resetPassword')}</Button>
            <Button size="sm" variant="ghost" onClick={() => status.mutate(r)}>{r.isActive ? t('deactivate') : t('activate')}</Button>
          </>
        )}
      />
      <Modal open={!!secret} onClose={() => setSecret(null)} title={t('resetPassword')} footer={<Button onClick={() => setSecret(null)}>{tc('close')}</Button>}>
        <p className="mb-2 text-sm text-muted">{t('shownOnce')}</p>
        <div className="rounded-lg bg-surface-2 p-3 font-mono"><div>{secret?.login}</div><div className="select-all text-lg font-bold">{secret?.newPassword}</div></div>
      </Modal>
    </>
  );
}
