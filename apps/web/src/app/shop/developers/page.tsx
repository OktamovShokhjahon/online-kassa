'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { WEBHOOK_EVENTS_LIST } from '@/lib/constants';
import { Badge, Button, Card, Checkbox, DataTable, Field, FormError, Input, Modal, PageHeader, Select, Tabs, useToast } from '@/components/ui';
import { BranchSelect } from '@/components/pickers';
import { api, del, patch, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false, loading: () => <p className="text-sm text-muted">…</p> });
const SCOPES = ['products:read', 'products:write', 'prices:read', 'stock:read', 'sales:read', 'sales:write', 'customers:read', 'reports:read'];

const Code = ({ children }: { children: string }) => <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed">{children}</pre>;

export default function DevelopersPage() {
  const t = useTranslations('shop.dev');
  const [tab, setTab] = useState<'start' | 'keys' | 'agent' | 'hardware' | 'protocol' | 'rest' | 'webhooks' | 'changelog'>('start');
  const [tryKey, setTryKey] = useState('');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Tabs value={tab} onChange={setTab} tabs={(['start', 'keys', 'agent', 'hardware', 'protocol', 'rest', 'webhooks', 'changelog'] as const).map((k) => ({ key: k, label: t(`tab.${k}`) }))} />
      {tab === 'start' && <GettingStarted />}
      {tab === 'keys' && <Keys onUse={(k) => { setTryKey(k); setTab('rest'); }} />}
      {tab === 'agent' && <AgentDocs />}
      {tab === 'hardware' && <Hardware />}
      {tab === 'protocol' && <Protocol />}
      {tab === 'rest' && (
        <div className="space-y-3">
          <Card title={t('tryIt')}><p className="mb-2 text-sm text-muted">{t('tryItHint')}</p><Input type="password" autoComplete="off" placeholder="kk_live_…" value={tryKey} onChange={(e) => setTryKey(e.target.value)} /></Card>
          <div className="rounded-xl border border-border bg-white p-2 text-black">
            <SwaggerUI url="/api/v1/docs/openapi.json" docExpansion="list" tryItOutEnabled requestInterceptor={(req: any) => { if (tryKey) req.headers.Authorization = `Bearer ${tryKey}`; return req; }} />
          </div>
        </div>
      )}
      {tab === 'webhooks' && <Webhooks />}
      {tab === 'changelog' && <Changelog />}
    </>
  );
}

function GettingStarted() {
  const t = useTranslations('shop.dev');
  const base = typeof window === 'undefined' ? '' : `${window.location.origin}/api/v1`;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('baseUrl')}><Code>{base}</Code><p className="mt-2 text-sm">{t('auth')}</p><Code>{`curl ${base}/public/products?limit=5 \\\n  -H "Authorization: Bearer kk_live_xxxxxxxx"`}</Code></Card>
      <Card title={t('limits')}><ul className="list-disc space-y-1 pl-5 text-sm"><li>{t('limit1')}</li><li>{t('limit2')}</li><li>{t('limit3')}</li><li>{t('limit4')}</li></ul></Card>
      <Card title={t('format')}><Code>{`{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 134 } }\n\n{ "error": { "code": "PRODUCT_NOT_FOUND", "message": "…", "details": [] } }`}</Code><p className="mt-2 text-sm">{t('errorCodes')}</p><Code>{'200 201 400 401 403 404 409 422 429 500'}</Code></Card>
      <Card title={t('idempotency')}><p className="text-sm">{t('idempotencyText')}</p><Code>{`POST /public/sales\n{ "clientRequestId": "order-2026-000123", "terminalId": "…", "shiftId": "…",\n  "lines": [{ "productId": "…", "qty": 2 }],\n  "payments": [{ "method": "card", "amount": 2400000 }] }`}</Code></Card>
    </div>
  );
}

function Keys({ onUse }: { onUse: (k: string) => void }) {
  const t = useTranslations('shop.dev');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['api-keys'], queryFn: () => api<any[]>('/api-keys') });
  const [form, setForm] = useState<null | { name: string; scopes: string[]; branchId: string; expiresAt: string }>(null);
  const [shown, setShown] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post('/api-keys', { name: form!.name, scopes: form!.scopes, branchId: form!.branchId || undefined, expiresAt: form!.expiresAt ? new Date(form!.expiresAt).toISOString() : undefined }),
    onSuccess: (k) => { qc.invalidateQueries({ queryKey: ['api-keys'] }); setForm(null); setShown(k.key); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/api-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }), onError: toast.error });
  return (
    <>
      <div className="mb-3 flex justify-end"><Button onClick={() => { create.reset(); setForm({ name: '', scopes: ['products:read'], branchId: '', expiresAt: '' }); }}>{t('newKey')}</Button></div>
      <DataTable rows={data} columns={[
        { key: 'name', header: tc('name'), render: (k: any) => <b>{k.name}</b> },
        { key: 'display', header: t('key'), render: (k: any) => <code className="text-xs">{k.display}</code> },
        { key: 'scopes', header: t('scopes'), render: (k: any) => <span className="text-xs">{k.scopes.join(', ')}</span> },
        { key: 'lastUsedAt', header: t('lastUsed'), render: (k: any) => fmtDateTime(k.lastUsedAt) },
        { key: 'requestCount', header: t('requests'), align: 'right' },
        { key: 'active', header: tc('status'), render: (k: any) => <Badge tone={k.active ? 'success' : 'danger'}>{k.active ? tc('active') : t('revoked')}</Badge> },
        { key: 'a', header: '', render: (k: any) => k.active && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.id)}>{t('revoke')}</Button> },
      ]} />
      <Modal open={!!form} onClose={() => setForm(null)} title={t('newKey')} footer={<><Button variant="secondary" onClick={() => setForm(null)}>{tc('cancel')}</Button><Button loading={create.isPending} disabled={!form?.name || !form.scopes.length} onClick={() => create.mutate()}>{tc('create')}</Button></>}>
        {form && <div className="space-y-3">
          <Field label={tc('name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('scopes')}><div className="grid gap-1 md:grid-cols-2">{SCOPES.map((s) => <Checkbox key={s} label={s} checked={form.scopes.includes(s)} onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter((x) => x !== s) })} />)}</div></Field>
          <Field label={tc('branch')} hint={t('branchHint')}><BranchSelect all value={form.branchId} onChange={(v) => setForm({ ...form, branchId: v })} /></Field>
          <Field label={t('expires')}><Input type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} /></Field>
          <FormError error={create.error} />
        </div>}
      </Modal>
      <Modal open={!!shown} onClose={() => setShown(null)} title={t('keyCreated')} footer={<><Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(shown!); toast.ok(t('copied')); }}>{t('copy')}</Button><Button variant="secondary" onClick={() => { onUse(shown!); setShown(null); }}>{t('tryIt')}</Button><Button onClick={() => setShown(null)}>{tc('close')}</Button></>}>
        <p className="mb-2 text-sm text-warn">{t('shownOnce')}</p>
        <Code>{shown ?? ''}</Code>
      </Modal>
    </>
  );
}

function AgentDocs() {
  const t = useTranslations('shop.dev');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title={t('agentInstall')}><ol className="list-decimal space-y-1 pl-5 text-sm"><li>{t('agent1')}</li><li>{t('agent2')}</li><li>{t('agent3')}</li><li>{t('agent4')}</li><li>{t('agent5')}</li></ol></Card>
      <Card title={t('troubleshoot')}>
        <dl className="space-y-3 text-sm">
          {(['noPrinter', 'wrongChars', 'portBusy', 'noScan', 'offline'] as const).map((k) => <div key={k}><dt className="font-medium">{t(`ts.${k}.q`)}</dt><dd className="text-muted">{t(`ts.${k}.a`)}</dd></div>)}
        </dl>
      </Card>
    </div>
  );
}

function Hardware() {
  const t = useTranslations('shop.dev');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Xprinter XP-58IIL (58 mm)"><ul className="list-disc space-y-1 pl-5 text-sm"><li>{t('hw.p1')}</li><li>{t('hw.p2')}</li><li>{t('hw.p3')}</li><li>{t('hw.p4')}</li></ul><Code>{'Paper 58 mm · 384 dots · 32 chars/line (font A)\nESC/POS · code page PC866 (ESC t 17)'}</Code></Card>
      <Card title="Netum A5 (2D scanner)"><ol className="list-decimal space-y-1 pl-5 text-sm"><li>{t('hw.s1')}</li><li>{t('hw.s2')}</li><li>{t('hw.s3')}</li><li>{t('hw.s4')}</li></ol><p className="mt-2 text-xs text-muted">{t('hw.configNote')}</p><Code>{'HID keyboard mode · suffix: Enter (CR) · no prefix\nGS (0x1D) transmitted for DataMatrix marking codes'}</Code></Card>
    </div>
  );
}

function Protocol() {
  const t = useTranslations('shop.dev');
  return (
    <div className="space-y-4">
      <Card title={t('protocolTitle')}><p className="mb-2 text-sm">{t('protocolText')}</p><Code>{`ws://127.0.0.1:17890\n→ { "type": "hello", "id": "1", "payload": { "terminalId": "…", "sessionKey": "…" } }\n← { "type": "ack",   "id": "1", "payload": { "agentVersion": "1.0.0" } }\n← { "type": "status", "id": "…", "payload": { "printer": "ok", "scanner": "none", "drawer": "enabled" } }`}</Code></Card>
      <Card title="print.receipt"><Code>{`→ { "type": "print.receipt", "id": "2", "payload": { "receipt": { …structured receipt… }, "copies": 1 } }\n← { "type": "ack", "id": "2", "payload": { "printed": true } }\n← { "type": "error", "id": "2", "payload": { "code": "PRINT_ERROR", "message": "Paper out" } }`}</Code></Card>
      <Card title="scan / drawer.open / print.label / print.report"><Code>{`← { "type": "scan", "id": "…", "payload": { "barcode": "4006381333931", "symbology": "serial", "timestamp": "…" } }\n→ { "type": "drawer.open", "id": "3", "payload": {} }\n→ { "type": "print.label", "id": "4", "payload": { "name": "Cola 1L", "price": 1200000, "barcode": "4006381333931", "quantity": 2 } }\n→ { "type": "print.report", "id": "5", "payload": { "report": { …x_report | z_report… } } }`}</Code></Card>
      <Card title="heartbeat (agent ↔ server, every 30 s)"><Code>{`→ { "type": "heartbeat", "id": "…", "payload": { "version": "1.0.0", "devices": { "printer": "ok", "scanner": "none" }, "uptime": 3600 } }`}</Code></Card>
    </div>
  );
}

function Webhooks() {
  const t = useTranslations('shop.dev');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['webhooks'], queryFn: () => api<any[]>('/webhooks') });
  const [form, setForm] = useState<null | { url: string; events: string[] }>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<any>(null);
  const deliveries = useQuery({ queryKey: ['deliveries', open?.id], queryFn: () => api<any[]>(`/webhooks/${open.id}/deliveries?limit=30`), enabled: !!open });
  const create = useMutation({ mutationFn: () => post('/webhooks', form), onSuccess: (w) => { qc.invalidateQueries({ queryKey: ['webhooks'] }); setForm(null); setSecret(w.secret); } });
  const toggle = useMutation({ mutationFn: (w: any) => patch(`/webhooks/${w.id}`, { isActive: !w.isActive }), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/webhooks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  const ping = useMutation({ mutationFn: (id: string) => post(`/webhooks/${id}/test`), onSuccess: (d) => toast.ok(`${t('ping')}: ${d.status} (${d.lastStatusCode ?? d.lastError})`), onError: toast.error });
  return (
    <>
      <div className="mb-3 flex items-center justify-between"><p className="text-sm text-muted">{t('webhookText')}</p><Button onClick={() => { create.reset(); setForm({ url: '', events: ['sale.created'] }); }}>{t('newWebhook')}</Button></div>
      <DataTable rows={data} columns={[
        { key: 'url', header: 'URL', render: (w: any) => <code className="text-xs">{w.url}</code> },
        { key: 'events', header: t('events'), render: (w: any) => <span className="text-xs">{w.events.join(', ')}</span> },
        { key: 'isActive', header: tc('status'), render: (w: any) => <Badge tone={w.isActive ? 'success' : 'neutral'}>{w.isActive ? tc('active') : tc('inactive')}</Badge> },
        { key: 'a', header: '', render: (w: any) => <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setOpen(w)}>{t('deliveries')}</Button><Button size="sm" variant="secondary" onClick={() => ping.mutate(w.id)}>{t('ping')}</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate(w)}>{w.isActive ? t('disable') : t('enable')}</Button><Button size="sm" variant="ghost" onClick={() => remove.mutate(w.id)}>{tc('delete')}</Button></div> },
      ]} />
      <Card title={t('signature')} className="mt-4"><Code>{`X-Kass-Signature: sha256=<hex>\nHMAC_SHA256(secret, X-Kass-Timestamp + "." + rawBody)\n\n// Node.js\nconst sig = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');`}</Code></Card>
      <Modal open={!!form} onClose={() => setForm(null)} title={t('newWebhook')} footer={<><Button variant="secondary" onClick={() => setForm(null)}>{tc('cancel')}</Button><Button loading={create.isPending} disabled={!form?.url || !form.events.length} onClick={() => create.mutate()}>{tc('create')}</Button></>}>
        {form && <div className="space-y-3"><Field label="URL"><Input value={form.url} placeholder="https://example.com/hooks/kass" onChange={(e) => setForm({ ...form, url: e.target.value })} /></Field><Field label={t('events')}><div className="grid gap-1 md:grid-cols-2">{WEBHOOK_EVENTS_LIST.map((e) => <Checkbox key={e} label={e} checked={form.events.includes(e)} onChange={(ev) => setForm({ ...form, events: ev.target.checked ? [...form.events, e] : form.events.filter((x) => x !== e) })} />)}</div></Field><FormError error={create.error} /></div>}
      </Modal>
      <Modal open={!!secret} onClose={() => setSecret(null)} title={t('signingSecret')} footer={<Button onClick={() => setSecret(null)}>{tc('close')}</Button>}><p className="mb-2 text-sm text-warn">{t('shownOnce')}</p><Code>{secret ?? ''}</Code></Modal>
      <Modal open={!!open} wide onClose={() => setOpen(null)} title={t('deliveries')} footer={<Button onClick={() => setOpen(null)}>{tc('close')}</Button>}>
        <DataTable rows={deliveries.data} columns={[
          { key: 'createdAt', header: tc('date'), render: (d: any) => fmtDateTime(d.createdAt) },
          { key: 'event', header: t('event') },
          { key: 'status', header: tc('status'), render: (d: any) => <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warn'}>{d.status}</Badge> },
          { key: 'attempts', header: t('attempts'), align: 'right' },
          { key: 'lastStatusCode', header: 'HTTP', render: (d: any) => d.lastStatusCode ?? d.lastError ?? '' },
        ]} />
      </Modal>
    </>
  );
}

function Changelog() {
  const t = useTranslations('shop.dev');
  const { data } = useQuery({ queryKey: ['api-changelog'], queryFn: () => api<any[]>('/docs/changelog') });
  return <div className="space-y-3">{data?.map((c) => <Card key={c.version} title={`v${c.version} · ${c.date}`}><ul className="list-disc pl-5 text-sm">{c.changes.map((x: string) => <li key={x}>{x}</li>)}</ul></Card>)}</div>;
}
