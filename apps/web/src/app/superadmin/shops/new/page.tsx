'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CURRENCIES, LANGUAGES, createShopSchema } from '@kass/shared';
import { Button, Card, Checkbox, Field, FormError, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { post } from '@/lib/api';

export default function NewShopPage() {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const tl = useTranslations('languages');
  const router = useRouter();
  const [f, setF] = useState({
    name: '', adminFullName: '', adminPhone: '+998 ', adminLogin: '', adminPassword: '', firstBranchName: 'Main branch', address: '', tin: '',
    currency: 'UZS', fiscalEnabled: false, adminLanguage: 'uz', paidUntil: '', maxBranches: '', maxTerminals: '', maxEmployees: '', note: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  const create = useMutation({
    mutationFn: (body: object) => post('/admin/shops', body),
    onSuccess: (d) => router.push(`/superadmin/shops/${d.shop.id}`),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const limits = Object.fromEntries(
      (['maxBranches', 'maxTerminals', 'maxEmployees'] as const).filter((k) => f[k]).map((k) => [k, Number(f[k])]),
    );
    const body = {
      name: f.name, adminFullName: f.adminFullName, adminPhone: f.adminPhone, adminLogin: f.adminLogin, adminPassword: f.adminPassword,
      firstBranchName: f.firstBranchName, address: f.address || undefined, tin: f.tin || undefined, currency: f.currency, fiscalEnabled: f.fiscalEnabled,
      adminLanguage: f.adminLanguage, paidUntil: f.paidUntil ? new Date(f.paidUntil).toISOString() : null, limits: Object.keys(limits).length ? limits : undefined, note: f.note || undefined,
    };
    // same Zod schema as the API: errors show up before the request is sent
    const parsed = createShopSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message === 'TIN_REQUIRED' ? t('shop.tinRequired') : i.message])));
      return;
    }
    setFieldErrors({});
    create.mutate(body);
  }

  const err = (k: string) => fieldErrors[k];
  return (
    <form onSubmit={submit} className="max-w-3xl space-y-4">
      <PageHeader title={t('shop.create')} />
      <Card title={t('shop.profile')}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('shop.name')} error={err('name')}><Input value={f.name} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label={t('shop.firstBranch')} error={err('firstBranchName')}><Input value={f.firstBranchName} onChange={(e) => set('firstBranchName', e.target.value)} /></Field>
          <Field label={t('shop.address')}><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
          <Field label={t('shop.tin')} error={err('tin')} hint={t('shop.tinHint')}><Input inputMode="numeric" maxLength={9} value={f.tin} onChange={(e) => set('tin', e.target.value)} /></Field>
          <Field label={tc('currency')}>
            <Select value={f.currency} onChange={(e) => set('currency', e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select>
          </Field>
          <Field label={t('shop.paidUntil')} hint={t('shop.trialHint')}><Input type="date" value={f.paidUntil} onChange={(e) => set('paidUntil', e.target.value)} /></Field>
        </div>
        <div className="mt-3"><Checkbox checked={f.fiscalEnabled} onChange={(e) => set('fiscalEnabled', e.target.checked)} label={t('shop.fiscalReceipts')} /></div>
      </Card>
      <Card title={t('shop.adminAccount')}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('shop.adminName')} error={err('adminFullName')}><Input value={f.adminFullName} onChange={(e) => set('adminFullName', e.target.value)} required /></Field>
          <Field label={tc('phone')} error={err('adminPhone')}><Input value={f.adminPhone} onChange={(e) => set('adminPhone', e.target.value)} required /></Field>
          <Field label={t('shop.adminLogin')} error={err('adminLogin')}><Input value={f.adminLogin} autoComplete="off" onChange={(e) => set('adminLogin', e.target.value)} required /></Field>
          <Field label={t('shop.adminPassword')} error={err('adminPassword')}><Input type="password" autoComplete="new-password" value={f.adminPassword} onChange={(e) => set('adminPassword', e.target.value)} required /></Field>
          <Field label={tc('language')}>
            <Select value={f.adminLanguage} onChange={(e) => set('adminLanguage', e.target.value)}>{LANGUAGES.map((l) => <option key={l} value={l}>{tl(l)}</option>)}</Select>
          </Field>
        </div>
      </Card>
      <Card title={t('shop.limits')}>
        <div className="grid gap-3 md:grid-cols-3">
          {(['maxBranches', 'maxTerminals', 'maxEmployees'] as const).map((k) => (
            <Field key={k} label={t(`shop.${k}`)} hint={t('shop.defaultHint')}><Input type="number" min={1} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>
          ))}
        </div>
        <Field label={tc('note')} className="mt-3" hint={t('shop.noteHint')}><Textarea value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
      </Card>
      <FormError error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" loading={create.isPending}>{tc('create')}</Button>
        <Button type="button" variant="secondary" onClick={() => router.back()}>{tc('cancel')}</Button>
      </div>
    </form>
  );
}
