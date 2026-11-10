'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { Badge, Button, Card, DataTable, Field, FormError, Input, Modal, useToast } from './ui';
import { api, patch } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

interface CredUser {
  id: string;
  role: string;
  fullName: string;
  phone?: string;
  login: string;
  password: string | null;
  isActive: boolean;
  lastLoginAt?: string | null;
}

/**
 * Logins and passwords of a shop's accounts: the superadmin sees every account of a shop, the shop
 * owner their staff. Passwords are hidden until revealed; each can be copied or changed.
 */
export function CredentialsCard({ endpoint, editPath, queryKey, title, note }: { endpoint: string; editPath: (id: string) => string; queryKey: unknown[]; title?: string; note?: string }) {
  const t = useTranslations('creds');
  const tc = useTranslations('common');
  const tr = useTranslations('roles');
  const toast = useToast();
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState<CredUser | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey, queryFn: () => api<CredUser[]>(endpoint) });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.ok(t('copied'));
    } catch {
      /* clipboard blocked: the text is selectable anyway */
    }
  };
  const visible = (id: string) => all || !!shown[id];

  return (
    <Card
      title={title ?? t('title')}
      actions={<Button size="sm" variant="ghost" onClick={() => setAll(!all)}><Icon name={all ? 'x' : 'search'} className="h-4 w-4" />{all ? t('hideAll') : t('showAll')}</Button>}
    >
      <p className="mb-3 text-sm text-muted">{note ?? t('note')}</p>
      <FormError error={error} />
      <DataTable
        rows={data ?? []}
        loading={isLoading}
        rowKey={(r: CredUser) => r.id}
        columns={[
          {
            key: 'fullName', header: tc('name'),
            render: (r: CredUser) => (
              <div>
                <span className="font-medium">{r.fullName}</span> {!r.isActive && <Badge>{tc('inactive')}</Badge>}
                <div className="text-xs text-muted">{tr(r.role)}{r.lastLoginAt ? ` · ${t('lastLogin')}: ${fmtDateTime(r.lastLoginAt)}` : ''}</div>
              </div>
            ),
          },
          {
            key: 'login', header: t('login'),
            render: (r: CredUser) => (
              <span className="inline-flex items-center gap-1.5">
                <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm">{r.login}</code>
                <CopyBtn label={t('copy')} onClick={() => copy(r.login)} />
              </span>
            ),
          },
          {
            key: 'password', header: t('password'),
            render: (r: CredUser) => r.password === null ? (
              <span className="text-xs text-muted" title={t('unknownHint')}>{t('unknown')}</span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <code className="select-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm">{visible(r.id) ? r.password : '••••••••'}</code>
                <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label={visible(r.id) ? t('hide') : t('show')} title={visible(r.id) ? t('hide') : t('show')} onClick={() => setShown({ ...shown, [r.id]: !shown[r.id] })}>
                  <EyeIcon off={visible(r.id)} />
                </button>
                <CopyBtn label={t('copy')} onClick={() => copy(r.password!)} />
              </span>
            ),
          },
          { key: '__a', header: '', align: 'right', render: (r: CredUser) => <Button size="sm" variant="secondary" onClick={() => setEdit(r)}>{tc('edit')}</Button> },
        ]}
      />
      <EditCredentials user={edit} onClose={() => setEdit(null)} path={edit ? editPath(edit.id) : ''} queryKey={queryKey} />
    </Card>
  );
}

function EditCredentials({ user, onClose, path, queryKey }: { user: CredUser | null; onClose: () => void; path: string; queryKey: unknown[] }) {
  const t = useTranslations('creds');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ fullName: '', login: '', password: '' });
  useEffect(() => { if (user) setF({ fullName: user.fullName, login: user.login, password: '' }); }, [user]);
  const body = () => ({
    ...(f.fullName.trim() && f.fullName.trim() !== user?.fullName ? { fullName: f.fullName.trim() } : {}),
    ...(f.login.trim() && f.login.trim().toLowerCase() !== user?.login ? { login: f.login.trim() } : {}),
    ...(f.password ? { password: f.password } : {}),
  });
  const save = useMutation({
    mutationFn: () => patch(path, body()),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); qc.invalidateQueries({ queryKey: ['staff'] }); toast.ok(tc('saved')); onClose(); },
  });
  const gen = () => {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const a = new Uint32Array(10);
    crypto.getRandomValues(a);
    setF({ ...f, password: Array.from(a, (n) => chars[n % chars.length]).join('') });
  };
  const changed = Object.keys(body()).length > 0;
  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`${t('editTitle')}: ${user?.fullName ?? ''}`}
      footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={save.isPending} disabled={!changed || (!!f.password && f.password.length < 8)} onClick={() => save.mutate()}>{tc('save')}</Button></>}
    >
      <div className="grid gap-3">
        <Field label={t('fullName')}><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label={t('login')} hint={t('loginHint')}><Input autoComplete="off" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></Field>
        <Field label={t('newPassword')} hint={t('passwordHint')} error={f.password && f.password.length < 8 ? t('tooShort') : undefined}>
          <div className="flex gap-2">
            <Input autoComplete="new-password" value={f.password} placeholder={t('keepPassword')} onChange={(e) => setF({ ...f, password: e.target.value })} className="font-mono" />
            <Button type="button" variant="secondary" onClick={gen}>{t('generate')}</Button>
          </div>
        </Field>
        <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">{t('signOutNote')}</p>
      </div>
      <FormError error={save.error} />
    </Modal>
  );
}

function CopyBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label={label} title={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
    </button>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}
