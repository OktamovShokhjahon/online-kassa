'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LANGUAGES } from '@kass/shared';
import { Icon } from '@/components/icons';
import { Badge, Button, Card, Checkbox, ConfirmModal, DataTable, Field, FormError, Input, Modal, Select, Skeleton, useToast } from '@/components/ui';
import { api, del, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

type PrinterType = 'windows' | 'serial' | 'network' | 'file' | 'none';
const BAUDS = [9600, 19200, 38400, 57600, 115200];
const PORTS = ['auto', 'none', ...Array.from({ length: 12 }, (_, i) => `COM${i + 1}`)];

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed">{children}</pre>
);

/** Superadmin › shop › Programs: the downloadable cash-desk program for one terminal. */
export function ProgramsTab({ shopId }: { shopId: string }) {
  const t = useTranslations('sa.prog');
  const tc = useTranslations('common');
  const tl = useTranslations('languages');
  const locale = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['sa-programs', shopId], queryFn: () => api<any>(`/admin/shops/${shopId}/programs`) });

  const [f, setF] = useState({
    terminalId: '', cashierId: '', apiUrl: '', language: locale,
    scannerPort: 'auto', scannerBaud: 9600,
    printerType: 'windows' as PrinterType, printerName: '', printerPort: '', host: '', tcpPort: 9100, paperMm: 58, codePage: 'CP866', cut: false, drawer: false,
  });
  const set = useCallback((patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch })), []);
  const [done, setDone] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<any>(null);

  useEffect(() => { if (!f.apiUrl && typeof window !== 'undefined') set({ apiUrl: `${window.location.origin}/api/v1` }); }, [f.apiUrl, set]);
  const terminals = useMemo(() => (data?.terminals ?? []).filter((x: any) => x.isActive), [data]);
  const terminal = terminals.find((x: any) => x.id === f.terminalId);
  const cashiers = useMemo(() => (data?.cashiers ?? []).filter((c: any) => !terminal || c.role === 'shop_admin' || c.branchIds.includes(terminal.branchId)), [data, terminal]);
  useEffect(() => { if (!f.terminalId && terminals.length) set({ terminalId: terminals[0].id }); }, [terminals, f.terminalId, set]);
  useEffect(() => {
    if (cashiers.length && !cashiers.some((c: any) => c.id === f.cashierId)) set({ cashierId: (cashiers.find((c: any) => c.role === 'cashier') ?? cashiers[0]).id });
  }, [cashiers, f.cashierId, set]);

  const download = useMutation({
    mutationFn: () =>
      post<any>(`/admin/shops/${shopId}/programs/desk`, {
        terminalId: f.terminalId,
        cashierId: f.cashierId,
        apiUrl: f.apiUrl.trim(),
        language: f.language,
        scanner: { port: f.scannerPort.trim() || 'auto', baudrate: f.scannerBaud },
        printer: { type: f.printerType, name: f.printerName.trim(), port: f.printerPort.trim(), host: f.host.trim(), tcpPort: f.tcpPort, paperMm: f.paperMm, codePage: f.codePage, cut: f.cut, drawer: f.drawer },
      }),
    onSuccess: (r) => {
      const blob = new Blob([r.content], { type: 'text/x-python;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: r.filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(r.filename);
      qc.invalidateQueries({ queryKey: ['sa-programs', shopId] });
    },
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => del(`/admin/shops/${shopId}/programs/${id}`),
    onSuccess: () => { setRevoke(null); toast.ok(t('revoked')); qc.invalidateQueries({ queryKey: ['sa-programs', shopId] }); },
    onError: toast.error,
  });

  if (isLoading) return <div className="grid gap-4 xl:grid-cols-[1fr_24rem]"><Skeleton className="h-96 rounded-xl" /><Skeleton className="h-96 rounded-xl" /></div>;
  const canDownload = !!(f.terminalId && f.cashierId && /^https?:\/\/.+/.test(f.apiUrl.trim()));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <div className="mb-5 flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary"><Icon name="terminals" className="h-6 w-6" /></span>
            <div>
              <h2 className="font-display text-lg font-semibold">{t('title')}</h2>
              <p className="mt-1 max-w-prose text-sm text-muted">{t('lead')}</p>
            </div>
          </div>

          {!terminals.length ? (
            <p className="rounded-xl border border-warn/50 bg-warn/5 px-4 py-3 text-sm">{t('noTerminals')}</p>
          ) : (
            <>
              <Section title={t('whereTitle')}>
                <Field label={t('terminal')}>
                  <Select value={f.terminalId} onChange={(e) => set({ terminalId: e.target.value })}>
                    {terminals.map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.branchName ? ` · ${x.branchName}` : ''}</option>)}
                  </Select>
                </Field>
                <Field label={t('cashier')} hint={t('cashierHint')}>
                  <Select value={f.cashierId} onChange={(e) => set({ cashierId: e.target.value })}>
                    {cashiers.map((c: any) => <option key={c.id} value={c.id}>{c.fullName} ({c.login})</option>)}
                  </Select>
                </Field>
                <Field label={t('apiUrl')} hint={t('apiUrlHint')}>
                  <Input value={f.apiUrl} onChange={(e) => set({ apiUrl: e.target.value })} spellCheck={false} />
                </Field>
                <Field label={t('language')}>
                  <Select value={f.language} onChange={(e) => set({ language: e.target.value })}>{LANGUAGES.map((l) => <option key={l} value={l}>{tl(l)}</option>)}</Select>
                </Field>
              </Section>

              <Section title={t('scannerTitle')}>
                <Field label={t('scannerPort')} hint={t('scannerPortHint')}>
                  <Input list="desk-ports" value={f.scannerPort} onChange={(e) => set({ scannerPort: e.target.value.toUpperCase() === 'AUTO' ? 'auto' : e.target.value })} spellCheck={false} />
                </Field>
                <Field label={t('baud')}>
                  <Select value={f.scannerBaud} onChange={(e) => set({ scannerBaud: +e.target.value })}>{BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}</Select>
                </Field>
              </Section>

              <Section title={t('printerTitle')}>
                <Field label={t('printerType')}>
                  <Select value={f.printerType} onChange={(e) => set({ printerType: e.target.value as PrinterType })}>
                    {(['windows', 'serial', 'network', 'file', 'none'] as const).map((p) => <option key={p} value={p}>{t(`types.${p}`)}</option>)}
                  </Select>
                </Field>
                {f.printerType === 'windows' && <Field label={t('printerName')} hint={t('printerNameHint')}><Input value={f.printerName} placeholder="XP-58" onChange={(e) => set({ printerName: e.target.value })} /></Field>}
                {f.printerType === 'serial' && <Field label={t('printerPort')}><Input list="desk-ports" value={f.printerPort} placeholder="COM4" onChange={(e) => set({ printerPort: e.target.value })} /></Field>}
                {f.printerType === 'network' && (
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <Field label={t('host')}><Input value={f.host} placeholder="192.168.1.50" onChange={(e) => set({ host: e.target.value })} /></Field>
                    <Field label={t('tcpPort')}><Input type="number" value={f.tcpPort} onChange={(e) => set({ tcpPort: +e.target.value || 9100 })} /></Field>
                  </div>
                )}
                {f.printerType !== 'none' && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label={t('paper')}><Select value={f.paperMm} onChange={(e) => set({ paperMm: +e.target.value })}><option value={58}>58 mm</option><option value={80}>80 mm</option></Select></Field>
                      <Field label={t('codePage')}><Select value={f.codePage} onChange={(e) => set({ codePage: e.target.value })}>{['CP866', 'CP1251', 'CP437', 'WPC1252'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
                    </div>
                    <div className="flex flex-wrap gap-x-6 gap-y-2 md:col-span-2">
                      <Checkbox checked={f.cut} onChange={(e) => set({ cut: e.target.checked })} label={t('cut')} />
                      <Checkbox checked={f.drawer} onChange={(e) => set({ drawer: e.target.checked })} label={t('drawer')} />
                    </div>
                  </>
                )}
              </Section>
              <datalist id="desk-ports">{PORTS.map((p) => <option key={p} value={p} />)}</datalist>

              <FormError error={download.error} />
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
                <Button loading={download.isPending} disabled={!canDownload} onClick={() => download.mutate()}>
                  <Icon name="arrowDown" className="h-4 w-4" /> {t('download')}
                </Button>
                <p className="text-xs text-muted">{t('downloadNote')}</p>
              </div>
            </>
          )}
        </Card>

        <Card title={t('howTitle')}>
          <ol className="space-y-4 text-sm">
            <Step n={1} text={t('step1')} />
            <Step n={2} text={t('step2')}><Code>{'pip install pyserial'}</Code></Step>
            <Step n={3} text={t('step3')}><Code>{'python kassa_desk_kassa_1.py'}</Code></Step>
            <Step n={4} text={t('step4')}><Code>{'pip install pyinstaller\npyinstaller --onefile --noconsole ^\n  --name OnlineKassDesk kassa_desk_kassa_1.py'}</Code></Step>
          </ol>
          <p className="mt-4 text-xs text-muted">{t('keys')}</p>
        </Card>
      </div>

      <Card title={t('copies')}>
        <DataTable
          rows={data?.programs}
          columns={[
            { key: 'terminalName', header: t('terminal') },
            { key: 'cashierName', header: t('cashier') },
            { key: 'display', header: t('key'), render: (r: any) => <span className="font-mono text-xs">{r.display}</span> },
            { key: 'createdAt', header: t('created'), render: (r: any) => fmtDateTime(r.createdAt) },
            { key: 'lastUsedAt', header: t('lastUsed'), render: (r: any) => (r.lastUsedAt ? fmtDateTime(r.lastUsedAt) : <span className="text-muted">{t('never')}</span>) },
            { key: 'active', header: tc('status'), render: (r: any) => (r.active ? <Badge tone="success" dot>{t('active')}</Badge> : <Badge>{t('revoked')}</Badge>) },
            { key: 'a', header: '', align: 'right', render: (r: any) => r.active && <Button size="sm" variant="ghost" onClick={() => setRevoke(r)}>{t('revoke')}</Button> },
          ]}
        />
      </Card>

      <Modal open={!!done} onClose={() => setDone(null)} title={t('downloadedTitle')} footer={<Button onClick={() => setDone(null)}>{tc('close')}</Button>}>
        <p className="text-sm">{t('downloaded', { file: done ?? '' })}</p>
        <div className="mt-3 space-y-2">
          <Code>{`python ${done ?? ''}`}</Code>
          <Code>{`pyinstaller --onefile --noconsole --name OnlineKassDesk ${done ?? ''}`}</Code>
        </div>
        <p className="mt-3 rounded-xl border border-warn/50 bg-warn/5 px-3 py-2 text-sm">{t('keyWarning')}</p>
      </Modal>
      <ConfirmModal open={!!revoke} onClose={() => setRevoke(null)} onConfirm={() => revokeM.mutate(revoke.id)} loading={revokeM.isPending} danger title={t('revoke')} message={t('revokeConfirm', { terminal: revoke?.terminalName ?? '' })} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mb-5">
      <legend className="mb-3 text-sm font-semibold">{title}</legend>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Step({ n, text, children }: { n: number; text: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/12 text-xs font-semibold text-primary">{n}</span>
      <div className="min-w-0 flex-1 space-y-2"><p>{text}</p>{children}</div>
    </li>
  );
}
