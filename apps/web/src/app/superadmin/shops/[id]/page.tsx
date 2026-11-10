'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { LANGUAGES, PAYMENT_METHODS, formatMoney, type Currency, type Language } from '@kass/shared';
import { Badge, Button, Card, DataTable, Field, FormError, Input, Modal, MoneyInput, PageHeader, Select, Spinner, Tabs, Textarea, Checkbox, useToast } from '@/components/ui';
import { ProgramsTab } from '@/components/superadmin/ProgramsTab';
import { ShopStatsTab } from '@/components/superadmin/ShopStatsTab';
import { ResetDialog } from '@/components/superadmin/ResetDialog';
import { CredentialsCard } from '@/components/credentials';
import { api, patch, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime } from '@/lib/format';

type Dialog = null | 'block' | 'payment' | 'edit' | 'reset' | 'wipe' | 'admin' | 'fiscal' | 'impersonate' | { terminal: any };

export default function ShopDetailPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const ts = useTranslations('shopStatus');
  const tl = useTranslations('languages');
  const lang = useLocale() as Language;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { applySession } = useAuth();
  const [tab, setTab] = useState<'overview' | 'stats' | 'users' | 'payments' | 'terminals' | 'programs'>('overview');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [secret, setSecret] = useState<{ login: string; newPassword: string } | null>(null);

  const { data: shop, isLoading } = useQuery({ queryKey: ['sa-shop', id], queryFn: () => api(`/admin/shops/${id}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['sa-shop', id] }); qc.invalidateQueries({ queryKey: ['sa-shops'] }); };
  const close = () => setDialog(null);
  const act = useMutation({ mutationFn: (fn: () => Promise<any>) => fn(), onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['sa-shop-users', id] }); close(); toast.ok(tc('saved')); }, onError: toast.error });

  if (isLoading || !shop) return <Spinner />;
  const cur = shop.currency as Currency;
  const money = (n: number) => formatMoney(n, cur, lang);
  const blocked = shop.status === 'blocked';

  async function impersonate() {
    const d = await post(`/admin/shops/${id}/impersonate`, { confirm: true });
    document.cookie = 'kass_role=shop_admin; path=/; max-age=3600; samesite=lax';
    applySession({ ...d, impersonatedBy: 'superadmin' }, { impersonating: true });
    router.push('/shop');
  }

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2">{shop.name} <Badge tone={blocked || shop.effectiveStatus === 'expired' ? 'danger' : shop.effectiveStatus === 'trial' ? 'info' : 'success'}>{ts(shop.effectiveStatus)}</Badge></span>}
        subtitle={shop.inGrace ? t('shop.graceNote', { days: shop.graceDaysLeft }) : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDialog('edit')}>{tc('edit')}</Button>
            <Button variant="secondary" onClick={() => setDialog('payment')}>{t('shop.recordPayment')}</Button>
            <Button variant="secondary" disabled={blocked} onClick={() => setDialog('impersonate')}>{t('shop.impersonate')}</Button>
            <Button variant="secondary" className="!text-danger" onClick={() => setDialog('wipe')}>{t('reset.button')}</Button>
            {blocked ? <Button onClick={() => act.mutate(() => post(`/admin/shops/${id}/unblock`))}>{t('shop.unblock')}</Button> : <Button variant="danger" onClick={() => setDialog('block')}>{t('shop.block')}</Button>}
          </>
        }
      />
      {blocked && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{t('shop.blockedBecause')}: {shop.blockReason}</p>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'overview', label: t('shop.overview') }, { key: 'stats', label: t('stats.tab') }, { key: 'users', label: t('shop.usersTab') }, { key: 'payments', label: t('shop.payments') }, { key: 'terminals', label: t('shop.terminals') }, { key: 'programs', label: t('prog.tab') }]} />

      {tab === 'programs' && <ProgramsTab shopId={id} />}
      {tab === 'stats' && <ShopStatsTab shopId={id} currency={cur} />}
      {tab === 'users' && (
        <CredentialsCard
          endpoint={`/admin/shops/${id}/users`}
          editPath={(uid) => `/admin/shops/${id}/users/${uid}`}
          queryKey={['sa-shop-users', id]}
          title={t('shop.usersTab')}
          note={t('shop.usersNote')}
        />
      )}

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('shop.profile')}>
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted">{tc('currency')}</dt><dd>{shop.currency}{shop.currencyLocked && ` (${t('shop.locked')})`}</dd>
              <dt className="text-muted">{t('shop.address')}</dt><dd>{shop.address || '—'}</dd>
              <dt className="text-muted">{t('shop.tin')}</dt><dd>{shop.tin || '—'}</dd>
              <dt className="text-muted">{t('shop.paidUntil')}</dt><dd>{fmtDate(shop.paidUntil) || t('shop.trial')}</dd>
              <dt className="text-muted">{t('shop.limits')}</dt><dd>{shop.limits.maxBranches} / {shop.limits.maxTerminals} / {shop.limits.maxEmployees} ({shop.branches.length} / {shop.terminals.length} / {shop.employeeCount})</dd>
              <dt className="text-muted">{tc('note')}</dt><dd>{shop.note || '—'}</dd>
            </dl>
          </Card>
          <Card title={t('shop.adminAccount')} actions={<><Button size="sm" variant="secondary" onClick={() => setTab('users')}>{t('shop.seeCredentials')}</Button><Button size="sm" variant="secondary" onClick={() => setDialog('reset')}>{t('shop.resetPassword')}</Button><Button size="sm" variant="secondary" onClick={() => setDialog('admin')}>{t('shop.changeAdmin')}</Button></>}>
            {shop.admin ? (
              <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
                <dt className="text-muted">{tc('name')}</dt><dd>{shop.admin.fullName}</dd>
                <dt className="text-muted">{tc('phone')}</dt><dd>{shop.admin.phone}</dd>
                <dt className="text-muted">{t('shop.adminLogin')}</dt><dd>{shop.admin.login}</dd>
                <dt className="text-muted">{tc('language')}</dt><dd>{tl(shop.admin.language)}</dd>
              </dl>
            ) : '—'}
          </Card>
          <Card title={t('shop.fiscalReceipts')} actions={<Button size="sm" variant="secondary" onClick={() => setDialog('fiscal')}>{tc('edit')}</Button>}>
            <p className="text-sm">{shop.fiscalEnabled ? <Badge tone="info">{tc('yes')}</Badge> : <Badge>{tc('no')}</Badge>} <span className="ml-2 text-muted">{t('shop.fiscalNote')}</span></p>
          </Card>
          <Card title={t('shop.branches')}>
            <ul className="space-y-1 text-sm">{shop.branches.map((b: any) => <li key={b.id}>{b.name} {!b.isActive && <Badge>{tc('inactive')}</Badge>}</li>)}</ul>
          </Card>
        </div>
      )}

      {tab === 'payments' && (
        <DataTable
          rows={shop.payments}
          columns={[
            { key: 'paidAt', header: tc('date'), render: (p: any) => fmtDate(p.paidAt) },
            { key: 'amount', header: tc('amount'), align: 'right', render: (p: any) => formatMoney(p.amount, p.currency, lang) },
            { key: 'period', header: t('shop.period'), render: (p: any) => `${fmtDate(p.periodFrom)} → ${fmtDate(p.periodTo)}` },
            { key: 'method', header: t('shop.method'), render: (p: any) => t(`method.${p.method}`) },
            { key: 'comment', header: tc('comment') },
          ]}
        />
      )}

      {tab === 'terminals' && (
        <DataTable
          rows={shop.terminals}
          columns={[
            { key: 'name', header: tc('name') },
            { key: 'agent', header: t('shop.agent'), render: (r: any) => (r.online ? <Badge tone="success">online</Badge> : <Badge>{r.lastSeenAt ? fmtDateTime(r.lastSeenAt) : '—'}</Badge>) },
            { key: 'version', header: 'v', render: (r: any) => r.agentVersion ?? '' },
            { key: 'fiscal', header: t('shop.fiscalModule'), render: (r: any) => r.fiscal?.provider ? `${r.fiscal.provider} ${r.fiscal.moduleId ?? ''}` : '—' },
            { key: 'a', header: tc('actions'), render: (r: any) => <Button size="sm" variant="secondary" disabled={!shop.fiscalEnabled} onClick={() => setDialog({ terminal: r })}>{t('shop.configureFiscal')}</Button> },
          ]}
        />
      )}

      {/* ----------------------------------------------------------------- dialogs */}
      <BlockDialog open={dialog === 'block'} onClose={close} onSubmit={(reason) => act.mutate(() => post(`/admin/shops/${id}/block`, { reason }))} error={act.error} busy={act.isPending} />
      <PaymentDialog open={dialog === 'payment'} onClose={close} currency={cur} onSubmit={(b) => act.mutate(() => post(`/admin/shops/${id}/payments`, b))} error={act.error} busy={act.isPending} />
      <EditDialog open={dialog === 'edit'} onClose={close} shop={shop} onSubmit={(b) => act.mutate(() => patch(`/admin/shops/${id}`, b))} error={act.error} busy={act.isPending} />
      <FiscalDialog open={dialog === 'fiscal'} onClose={close} shop={shop} onSubmit={(b) => act.mutate(() => patch(`/admin/shops/${id}/fiscal`, b))} error={act.error} busy={act.isPending} />
      <AdminDialog open={dialog === 'admin'} onClose={close} onSubmit={(b) => act.mutate(() => post(`/admin/shops/${id}/change-admin`, b))} error={act.error} busy={act.isPending} />
      <ResetDialog shopId={id} open={dialog === 'wipe'} onClose={close} />
      <TerminalFiscalDialog terminal={typeof dialog === 'object' && dialog ? dialog.terminal : null} onClose={close} onSubmit={(tid, b) => act.mutate(() => put(`/admin/shops/${id}/terminals/${tid}/fiscal`, b))} error={act.error} busy={act.isPending} />

      <Modal open={dialog === 'impersonate'} onClose={close} title={t('shop.impersonate')} footer={<><Button variant="secondary" onClick={close}>{tc('cancel')}</Button><Button onClick={() => impersonate().catch(toast.error)}>{tc('confirm')}</Button></>}>
        <p className="text-sm">{t('shop.impersonateWarning')}</p>
      </Modal>
      <Modal open={dialog === 'reset'} onClose={close} title={t('shop.resetPassword')} footer={<><Button variant="secondary" onClick={close}>{tc('cancel')}</Button><Button onClick={async () => { try { setSecret(await post(`/admin/shops/${id}/reset-admin-password`, {})); qc.invalidateQueries({ queryKey: ['sa-shop-users', id] }); close(); } catch (e) { toast.error(e); } }}>{tc('confirm')}</Button></>}>
        <p className="text-sm">{t('shop.resetWarning')}</p>
      </Modal>
      <Modal open={!!secret} onClose={() => setSecret(null)} title={t('shop.newPassword')} footer={<Button onClick={() => setSecret(null)}>{tc('close')}</Button>}>
        <p className="mb-2 text-sm text-muted">{t('shop.shownOnce')}</p>
        <div className="rounded-lg bg-surface-2 p-3 font-mono text-sm"><div>{secret?.login}</div><div className="select-all text-lg font-bold">{secret?.newPassword}</div></div>
      </Modal>
      <span className="hidden">{LANGUAGES.length}{PAYMENT_METHODS.length}</span>
    </>
  );
}

type DProps = { open: boolean; onClose: () => void; error: unknown; busy: boolean };

function BlockDialog({ open, onClose, onSubmit, error, busy }: DProps & { onSubmit: (reason: string) => void }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const [reason, setReason] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={t('shop.block')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 2} onClick={() => onSubmit(reason)}>{t('shop.block')}</Button></>}>
      <p className="mb-3 text-sm text-muted">{t('shop.blockWarning')}</p>
      <Field label={tc('reason')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function PaymentDialog({ open, onClose, onSubmit, error, busy, currency }: DProps & { currency: Currency; onSubmit: (b: object) => void }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const [f, setF] = useState<{ amount: number | null; periodFrom: string; periodTo: string; paidAt: string; method: string; comment: string }>({ amount: null, periodFrom: fmtDate(new Date()), periodTo: '', paidAt: fmtDate(new Date()), method: 'bank_transfer', comment: '' });
  return (
    <Modal open={open} onClose={onClose} title={t('shop.recordPayment')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!f.amount || !f.periodTo} onClick={() => onSubmit({ amount: f.amount, currency, periodFrom: new Date(f.periodFrom).toISOString(), periodTo: new Date(f.periodTo).toISOString(), paidAt: new Date(f.paidAt).toISOString(), method: f.method, comment: f.comment || undefined })}>{tc('save')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={`${tc('amount')} (${currency})`}><MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label={t('shop.method')}><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`method.${m}`)}</option>)}</Select></Field>
        <Field label={t('shop.periodFrom')}><Input type="date" value={f.periodFrom} onChange={(e) => setF({ ...f, periodFrom: e.target.value })} /></Field>
        <Field label={t('shop.periodTo')} hint={t('shop.periodHint')}><Input type="date" value={f.periodTo} onChange={(e) => setF({ ...f, periodTo: e.target.value })} /></Field>
        <Field label={tc('date')}><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
        <Field label={tc('comment')}><Input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} /></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function EditDialog({ open, onClose, onSubmit, error, busy, shop }: DProps & { shop: any; onSubmit: (b: object) => void }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const [f, setF] = useState({ name: shop.name, address: shop.address ?? '', note: shop.note ?? '', paidUntil: fmtDate(shop.paidUntil), ...shop.limits });
  return (
    <Modal open={open} onClose={onClose} title={tc('edit')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} onClick={() => onSubmit({ name: f.name, address: f.address, note: f.note, paidUntil: f.paidUntil ? new Date(f.paidUntil).toISOString() : null, limits: { maxBranches: +f.maxBranches, maxTerminals: +f.maxTerminals, maxEmployees: +f.maxEmployees } })}>{tc('save')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('shop.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('shop.address')}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label={t('shop.paidUntil')}><Input type="date" value={f.paidUntil} onChange={(e) => setF({ ...f, paidUntil: e.target.value })} /></Field>
        <span />
        {(['maxBranches', 'maxTerminals', 'maxEmployees'] as const).map((k) => <Field key={k} label={t(`shop.${k}`)}><Input type="number" min={1} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
      </div>
      <Field label={tc('note')} className="mt-3"><Textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <FormError error={error} />
    </Modal>
  );
}

function FiscalDialog({ open, onClose, onSubmit, error, busy, shop }: DProps & { shop: any; onSubmit: (b: object) => void }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const [on, setOn] = useState<boolean>(shop.fiscalEnabled);
  const [tin, setTin] = useState<string>(shop.tin ?? '');
  return (
    <Modal open={open} onClose={onClose} title={t('shop.fiscalReceipts')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} onClick={() => onSubmit({ fiscalEnabled: on, ...(tin ? { tin } : {}) })}>{tc('save')}</Button></>}>
      <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)} label={t('shop.fiscalReceipts')} />
      <Field label={t('shop.tin')} className="mt-3" hint={t('shop.tinHint')}><Input inputMode="numeric" maxLength={9} value={tin} onChange={(e) => setTin(e.target.value)} /></Field>
      <p className="mt-3 text-xs text-muted">{t('shop.fiscalOffNote')}</p>
      <FormError error={error} />
    </Modal>
  );
}

function AdminDialog({ open, onClose, onSubmit, error, busy }: DProps & { onSubmit: (b: object) => void }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const tl = useTranslations('languages');
  const [f, setF] = useState({ fullName: '', phone: '+998 ', login: '', password: '', language: 'uz' });
  return (
    <Modal open={open} onClose={onClose} title={t('shop.changeAdmin')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} onClick={() => onSubmit(f)}>{tc('save')}</Button></>}>
      <p className="mb-3 text-sm text-muted">{t('shop.changeAdminNote')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('shop.adminName')}><Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label={tc('phone')}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label={t('shop.adminLogin')}><Input autoComplete="off" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} /></Field>
        <Field label={t('shop.adminPassword')}><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label={tc('language')}><Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{LANGUAGES.map((l) => <option key={l} value={l}>{tl(l)}</option>)}</Select></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}

function TerminalFiscalDialog({ terminal, onClose, onSubmit, error, busy }: { terminal: any | null; onClose: () => void; onSubmit: (tid: string, b: object) => void; error: unknown; busy: boolean }) {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const { data: providers } = useQuery({ queryKey: ['fiscal-providers'], queryFn: () => api<string[]>('/admin/fiscal-providers'), enabled: !!terminal });
  const [f, setF] = useState({ provider: 'mock', moduleId: '', credentials: '{}' });
  let parsed: object | null = null;
  try { parsed = JSON.parse(f.credentials); } catch { parsed = null; }
  return (
    <Modal open={!!terminal} onClose={onClose} title={`${t('shop.configureFiscal')}: ${terminal?.name ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!parsed} onClick={() => onSubmit(terminal.id, { provider: f.provider, moduleId: f.moduleId || undefined, credentials: parsed })}>{tc('save')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('shop.provider')}><Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>{(providers ?? ['mock']).map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <Field label={t('shop.moduleId')}><Input value={f.moduleId} onChange={(e) => setF({ ...f, moduleId: e.target.value })} /></Field>
        <Field label={t('shop.credentials')} error={parsed ? undefined : 'JSON'} hint={t('shop.credentialsHint')}><Textarea className="font-mono" rows={5} value={f.credentials} onChange={(e) => setF({ ...f, credentials: e.target.value })} /></Field>
      </div>
      <FormError error={error} />
    </Modal>
  );
}
