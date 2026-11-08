'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CrudPage } from '@/components/crud';
import { useBranches } from '@/components/pickers';
import { Badge, Button, Modal, useToast } from '@/components/ui';
import { del, post } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';

export default function TerminalsPage() {
  const t = useTranslations('shop.terminals');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { data: branches } = useBranches();
  const [pairing, setPairing] = useState<{ name: string; code: string; expiresAt: string } | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!pairing) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pairing]);
  const revoke = useMutation({ mutationFn: (id: string) => del(`/terminals/${id}/agent`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['terminals-list'] }); toast.ok(tc('saved')); }, onError: toast.error });

  return (
    <>
      <CrudPage<any>
        title={t('title')}
        endpoint="/terminals"
        queryKey="terminals-list"
        searchable={false}
        emptyForm={{ name: '', branchId: '', isActive: true, paperWidthMm: '58', codePage: 'CP866', cutEnabled: false, drawerEnabled: false }}
        fromRow={(r) => ({ name: r.name, branchId: r.branchId, isActive: r.isActive, paperWidthMm: String(r.printerProfile?.paperWidthMm ?? 58), codePage: r.printerProfile?.codePage ?? 'CP866', cutEnabled: !!r.printerProfile?.cutEnabled, drawerEnabled: !!r.printerProfile?.drawerEnabled })}
        toBody={(f) => ({ name: f.name, branchId: f.branchId, isActive: f.isActive, printerProfile: { paperWidthMm: Number(f.paperWidthMm), printWidthDots: f.paperWidthMm === '80' ? 576 : 384, charsPerLine: f.paperWidthMm === '80' ? 48 : 32, codePage: f.codePage, cutEnabled: f.cutEnabled, drawerEnabled: f.drawerEnabled } })}
        fields={[
          { key: 'name', label: tc('name'), required: true },
          { key: 'branchId', label: tc('branch'), type: 'select', required: true, options: branches?.map((b) => ({ value: b.id, label: b.name })) ?? [] },
          { key: 'paperWidthMm', label: t('paper'), type: 'select', required: true, options: [{ value: '58', label: '58 mm (32)' }, { value: '80', label: '80 mm (48)' }] },
          { key: 'codePage', label: t('codePage'), type: 'select', required: true, options: ['CP866', 'CP437', 'CP1251', 'WPC1252'].map((c) => ({ value: c, label: c })), hint: t('codePageHint') },
          { key: 'cutEnabled', label: t('cut'), type: 'checkbox', hint: t('cutHint') },
          { key: 'drawerEnabled', label: t('drawer'), type: 'checkbox' },
          { key: 'isActive', label: tc('active'), type: 'checkbox' },
        ]}
        columns={[
          { key: 'name', header: tc('name'), render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'branchId', header: tc('branch'), render: (r) => branches?.find((b) => b.id === r.branchId)?.name },
          { key: 'agent', header: t('agent'), render: (r) => (r.paired ? (r.online ? <Badge tone="success">{t('online')}</Badge> : <Badge tone="warn">{t('offline')}</Badge>) : <Badge>{t('notPaired')}</Badge>) },
          { key: 'seen', header: t('lastSeen'), render: (r) => <span className="text-xs text-muted">{fmtDateTime(r.lastSeenAt)} {r.agentVersion && `· v${r.agentVersion}`}</span> },
        ]}
        rowActions={(r) => (
          <>
            <Button size="sm" variant="secondary" onClick={async () => { try { const c = await post(`/terminals/${r.id}/pairing-code`); setPairing({ name: r.name, ...c }); } catch (e) { toast.error(e); } }}>{t('pair')}</Button>
            {r.paired && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(r.id)}>{t('revoke')}</Button>}
          </>
        )}
      />
      <Modal open={!!pairing} onClose={() => setPairing(null)} title={`${t('pair')}: ${pairing?.name ?? ''}`} footer={<Button onClick={() => setPairing(null)}>{tc('close')}</Button>}>
        <p className="mb-3 text-sm">{t('pairSteps')}</p>
        <div className="rounded-xl bg-surface-2 py-6 text-center font-mono text-4xl font-bold tracking-[0.3em]">{pairing?.code}</div>
        <p className="mt-3 text-center text-sm text-muted">{left > 0 ? t('validFor', { min: Math.floor(left / 60), sec: String(left % 60).padStart(2, '0') }) : t('expired')}</p>
      </Modal>
    </>
  );
}
