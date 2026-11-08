'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageHeader, Spinner, useToast } from '@/components/ui';
import { api, patch, post } from '@/lib/api';

export default function PlatformSettingsPage() {
  const t = useTranslations('sa');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['sa-settings'], queryFn: () => api('/admin/settings') });
  const tg = useQuery({ queryKey: ['sa-tg'], queryFn: () => api('/admin/telegram/recipients') });
  const [f, setF] = useState<any>(null);
  const [link, setLink] = useState<any>(null);
  useEffect(() => { if (data) setF({ platformName: data.platformName, graceDays: data.graceDays, longShiftHours: data.longShiftHours, ...data.defaultLimits, agentVersion: data.agentInstaller?.version ?? '', agentUrl: data.agentInstaller?.url ?? '' }); }, [data]);
  const save = useMutation({
    mutationFn: () => patch('/admin/settings', { platformName: f.platformName, graceDays: +f.graceDays, longShiftHours: +f.longShiftHours, defaultLimits: { maxBranches: +f.maxBranches, maxTerminals: +f.maxTerminals, maxEmployees: +f.maxEmployees }, agentInstaller: { version: f.agentVersion, url: f.agentUrl } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sa-settings'] }); toast.ok(tc('saved')); },
    onError: toast.error,
  });
  if (!f) return <Spinner />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <>
      <PageHeader title={t('nav.settings')} actions={<Button loading={save.isPending} onClick={() => save.mutate()}>{tc('save')}</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('settings.platform')}>
          <div className="space-y-3">
            <Field label={t('settings.platformName')}><Input value={f.platformName} onChange={(e) => set('platformName', e.target.value)} /></Field>
            <Field label={t('settings.graceDays')}><Input type="number" min={0} value={f.graceDays} onChange={(e) => set('graceDays', e.target.value)} /></Field>
            <Field label={t('settings.longShiftHours')}><Input type="number" min={1} value={f.longShiftHours} onChange={(e) => set('longShiftHours', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title={t('settings.defaultLimits')}>
          <div className="grid grid-cols-3 gap-3">
            {(['maxBranches', 'maxTerminals', 'maxEmployees'] as const).map((k) => <Field key={k} label={t(`shop.${k}`)}><Input type="number" min={1} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>)}
          </div>
        </Card>
        <Card title={t('settings.agent')}>
          <div className="space-y-3">
            <Field label={t('settings.agentVersion')}><Input value={f.agentVersion} onChange={(e) => set('agentVersion', e.target.value)} /></Field>
            <Field label={t('settings.agentUrl')}><Input value={f.agentUrl} onChange={(e) => set('agentUrl', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title={t('settings.telegram')} actions={<Button size="sm" variant="secondary" onClick={async () => setLink(await post('/admin/telegram/link'))}>{t('settings.linkTelegram')}</Button>}>
          {link && <p className="mb-3 break-all rounded-lg bg-surface-2 p-2 text-sm">{link.url ? <a className="text-primary underline" href={link.url} target="_blank" rel="noreferrer">{link.url}</a> : <code>{link.command}</code>}</p>}
          <ul className="space-y-1 text-sm">{tg.data?.map((r: any) => <li key={r.id}>@{r.username ?? r.chatId}</li>)}</ul>
          <p className="mt-2 text-xs text-muted">{t('settings.telegramNote')}</p>
        </Card>
      </div>
    </>
  );
}
