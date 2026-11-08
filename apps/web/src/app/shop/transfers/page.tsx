'use client';

import { useTranslations } from 'next-intl';
import { BranchSelect, useBranches } from '@/components/pickers';
import { DocPage } from '@/components/DocPage';
import { Badge, Field, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function TransfersPage() {
  const t = useTranslations('shop.transfers');
  const td = useTranslations('shop.docs');
  const { can } = useAuth();
  const { data: branches } = useBranches();
  const name = (id: string) => branches?.find((b) => b.id === id)?.name ?? '';
  const ok = can('stock.transfer');
  return (
    <DocPage
      ns="transfers" title={t('title')} endpoint="/transfers" canCreate={ok} lineMode="qty" statuses={['draft', 'sent', 'received', 'cancelled']}
      postAction={{ label: t('createAndSend'), path: '/transfers/:id/send' }}
      blankForm={() => ({ fromBranchId: '', toBranchId: '', note: '' })}
      renderHeader={(f, set) => (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('from')}><BranchSelect value={f.fromBranchId} onChange={(v) => set({ fromBranchId: v })} /></Field>
          <Field label={t('to')}><BranchSelect value={f.toBranchId} onChange={(v) => set({ toBranchId: v })} /></Field>
          <Field label={td('note')} className="md:col-span-2"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} /></Field>
        </div>
      )}
      buildBody={(f, lines) => ({ fromBranchId: f.fromBranchId, toBranchId: f.toBranchId, note: f.note || undefined, lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty })) })}
      columns={[
        { key: 'fromBranchId', header: t('from'), render: (r: any) => name(r.fromBranchId) },
        { key: 'toBranchId', header: t('to'), render: (r: any) => name(r.toBranchId) },
        { key: 'discrepancy', header: t('discrepancy'), render: (r: any) => (r.discrepancy ? <Badge tone="warn">{t('discrepancy')}</Badge> : '') },
      ]}
      actions={(d) => [
        ...(d.status === 'draft' && ok ? [{ key: 'send', label: t('send'), path: `/transfers/${d.id}/send`, variant: 'primary' as const }] : []),
        ...(d.status === 'sent' && ok ? [{ key: 'receive', label: t('receive'), path: `/transfers/${d.id}/receive`, variant: 'primary' as const, receive: true }] : []),
        ...(['draft', 'sent'].includes(d.status) && ok ? [{ key: 'cancel', label: td('cancel'), path: `/transfers/${d.id}/cancel`, variant: 'danger' as const, needsReason: true }] : []),
      ]}
      mapLines={(d) => d.lines.map((l: any) => ({ product: { id: l.productId, name: l.productName ?? l.productId, barcode: l.barcode }, qty: l.qtyReceived ?? l.qtySent }))}
      detailExtra={(d) => (
        <p>{name(d.fromBranchId)} → {name(d.toBranchId)}{d.status === 'received' && d.receiveNote ? ` · ${d.receiveNote}` : ''}{d.discrepancy && <Badge tone="warn"> {t('discrepancy')}: {d.lines.map((l: any) => `${l.qtySent}→${l.qtyReceived}`).join(', ')}</Badge>}</p>
      )}
    />
  );
}
