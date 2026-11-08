'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inventoryEnabled } from '@kass/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CURRENCIES, LANGUAGES } from '@kass/shared';
import { Badge, Button, Card, Checkbox, Field, FormError, Input, MoneyInput, PageHeader, Select, Spinner, Textarea, useToast } from '@/components/ui';
import { api, apiRaw, del, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function ShopSettingsPage() {
  const t = useTranslations('shop.settings');
  const tc = useTranslations('common');
  const tl = useTranslations('languages');
  const toast = useToast();
  const qc = useQueryClient();
  const { shop, reload } = useAuth();
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (!shop) return;
    const s = shop.settings;
    setF({ name: shop.name, address: '', tin: '', currency: shop.currency, allowNegativeStock: s.allowNegativeStock, maxCashierDiscount: s.maxCashierDiscount, receiptLanguage: s.receiptLanguage, receiptHeader: s.receiptHeader ?? '', receiptFooter: s.receiptFooter ?? '', openShiftAlertHours: s.openShiftAlertHours, bonusPercent: s.loyalty.bonusPercent, maxPayPercent: s.loyalty.maxPayPercent });
  }, [shop]);
  const save = useMutation({
    mutationFn: () => patch('/settings', { name: f.name, ...(f.address ? { address: f.address } : {}), ...(f.tin && !shop?.fiscalEnabled ? { tin: f.tin } : {}), currency: f.currency, allowNegativeStock: f.allowNegativeStock, maxCashierDiscount: Number(f.maxCashierDiscount), receiptLanguage: f.receiptLanguage, receiptHeader: f.receiptHeader, receiptFooter: f.receiptFooter, openShiftAlertHours: Number(f.openShiftAlertHours), loyalty: { bonusPercent: Number(f.bonusPercent), maxPayPercent: Number(f.maxPayPercent) } }),
    onSuccess: async () => { await reload(); toast.ok(tc('saved')); },
  });
  const uploadLogo = async (file: File) => {
    const fd = new FormData(); fd.append('file', file);
    const res = await apiRaw('/settings/logo', { method: 'POST', form: fd });
    if (res.ok) { await reload(); toast.ok(tc('saved')); } else toast.error(new Error((await res.json()).error?.message));
  };
  if (!f || !shop) return <Spinner />;
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  return (
    <>
      <PageHeader title={t('title')} actions={<Button loading={save.isPending} onClick={() => save.mutate()}>{tc('save')}</Button>} />
      <FormError error={save.error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <Card title={t('shop')}>
          <div className="space-y-3">
            <Field label={tc('name')}><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label={t('address')}><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
            <Field label={t('tin')} hint={shop.fiscalEnabled ? t('tinFiscal') : undefined}><Input disabled={shop.fiscalEnabled} inputMode="numeric" maxLength={9} value={f.tin} onChange={(e) => set('tin', e.target.value)} /></Field>
            <Field label={tc('currency')} hint={shop.currencyLocked ? t('currencyLocked') : t('currencyFree')}><Select disabled={shop.currencyLocked} value={f.currency} onChange={(e) => set('currency', e.target.value)}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label={t('logo')}>{shop.logoUrl && <img src={shop.logoUrl} alt="logo" className="mb-2 h-14" />}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} /></Field>
            <p className="text-sm">{t('fiscal')}: {shop.fiscalEnabled ? <Badge tone="info">{tc('yes')}</Badge> : <Badge>{tc('no')}</Badge>} <span className="text-xs text-muted">{t('fiscalNote')}</span></p>
          </div>
        </Card>
        <Card title={t('sales')}>
          <div className="space-y-3">
            {inventoryEnabled() && <Checkbox checked={f.allowNegativeStock} onChange={(e) => set('allowNegativeStock', e.target.checked)} label={t('negativeStock')} />}
            {inventoryEnabled() && <p className="text-xs text-muted">{t('negativeStockHint')}</p>}
            <Field label={t('maxDiscount')} hint={t('maxDiscountHint')}><Input type="number" min={0} max={100} value={f.maxCashierDiscount} onChange={(e) => set('maxCashierDiscount', e.target.value)} /></Field>
            <Field label={t('shiftAlert')}><Input type="number" min={1} value={f.openShiftAlertHours} onChange={(e) => set('openShiftAlertHours', e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('bonusPercent')}><Input type="number" min={0} max={100} step="0.1" value={f.bonusPercent} onChange={(e) => set('bonusPercent', e.target.value)} /></Field>
              <Field label={t('maxPayPercent')}><Input type="number" min={0} max={100} value={f.maxPayPercent} onChange={(e) => set('maxPayPercent', e.target.value)} /></Field>
            </div>
          </div>
        </Card>
        <Card title={t('receipt')}>
          <div className="space-y-3">
            <Field label={t('receiptLanguage')}><Select value={f.receiptLanguage} onChange={(e) => set('receiptLanguage', e.target.value)}>{LANGUAGES.map((l) => <option key={l} value={l}>{tl(l)}</option>)}</Select></Field>
            <Field label={t('header')} hint={t('branchOverride')}><Textarea rows={2} value={f.receiptHeader} onChange={(e) => set('receiptHeader', e.target.value)} /></Field>
            <Field label={t('footer')}><Textarea rows={2} value={f.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} /></Field>
          </div>
        </Card>
        <TelegramCard />
      </div>
      <span className="hidden">{qc.getQueryCache().getAll().length}{MoneyInput.name}</span>
    </>
  );
}

const PREFS = (['dailySummary', 'shiftClosed', 'refundAbove', 'lowStock', 'negativeStock', 'longShift', 'debtsOverdue', 'subscriptionExpiring'] as const).filter((k) => inventoryEnabled() || (k !== 'lowStock' && k !== 'negativeStock'));

function TelegramCard() {
  const tt = useTranslations('shop.telegram');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const [link, setLink] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['tg-recipients'], queryFn: () => api<any[]>('/telegram/recipients'), refetchInterval: link ? 4000 : false });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: object }) => patch(`/telegram/recipients/${id}`, body), onSuccess: () => qc.invalidateQueries({ queryKey: ['tg-recipients'] }), onError: toast.error });
  const remove = useMutation({ mutationFn: (id: string) => del(`/telegram/recipients/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['tg-recipients'] }) });
  const isOn = (r: any, k: string) => (typeof r.notifications[k] === 'object' ? !!r.notifications[k].enabled : r.notifications[k] !== false);
  return (
    <Card title={tt('title')} className="lg:col-span-2" actions={<><Button size="sm" variant="secondary" onClick={async () => { const r = await api('/telegram/test', { method: 'POST', json: {} }); toast.ok(`${tt('sent')}: ${r.sent}`); }}>{tt('test')}</Button><Button size="sm" onClick={async () => setLink(await post('/telegram/link'))}>{tt('link')}</Button></>}>
      {link && <div className="mb-3 rounded-lg bg-surface-2 p-3 text-sm">{link.url ? <a className="break-all text-primary underline" href={link.url} target="_blank" rel="noreferrer">{link.url}</a> : <code className="break-all">{link.command}</code>}<p className="mt-1 text-xs text-muted">{tt('linkNote')}</p></div>}
      {!data?.length && <p className="text-sm text-muted">{tt('none')}</p>}
      <div className="space-y-4">
        {data?.map((r) => (
          <div key={r.id} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><b>{r.userName} <span className="font-normal text-muted">@{r.username ?? r.chatId}</span></b>
              <div className="flex items-center gap-2"><Select className="h-8 w-32" value={r.language} onChange={(e) => update.mutate({ id: r.id, body: { language: e.target.value } })}>{LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}</Select><Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}>{tc('delete')}</Button></div></div>
            <div className="grid gap-2 md:grid-cols-2">
              {PREFS.map((k) => <Checkbox key={k} checked={isOn(r, k)} onChange={(e) => update.mutate({ id: r.id, body: { notifications: { [k]: typeof r.notifications[k] === 'object' ? { enabled: e.target.checked } : e.target.checked } } })} label={tt(`pref.${k}`)} />)}
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">{tt('dailyTime')} <Input type="time" className="h-8 w-28" defaultValue={r.notifications.dailySummary?.time ?? '21:00'} onBlur={(e) => update.mutate({ id: r.id, body: { notifications: { dailySummary: { time: e.target.value } } } })} /></label>
              <label className="flex items-center gap-2">{tt('refundAmount')} <MoneyInput className="h-8 w-32" value={r.notifications.refundAbove?.amount ?? 0} onChange={(v) => v !== null && update.mutate({ id: r.id, body: { notifications: { refundAbove: { amount: v } } } })} /></label>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
