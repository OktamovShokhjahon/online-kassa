'use client';

import { useTranslations } from 'next-intl';
import { WRITE_OFF_REASONS } from '@kass/shared';
import { BranchSelect } from '@/components/pickers';
import { DocPage } from '@/components/DocPage';
import { Field, Input, Select } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useMoney } from '@/lib/format';

export default function WriteOffsPage() {
  const t = useTranslations('shop.writeoffs');
  const td = useTranslations('shop.docs');
  const { can } = useAuth();
  const { m } = useMoney();
  const ok = can('stock.writeoff');
  return (
    <DocPage
      ns="writeoffs" title={t('title')} endpoint="/write-offs" canCreate={ok} lineMode="qty" statuses={['draft', 'posted', 'cancelled']}
      blankForm={() => ({ branchId: '', reason: 'damaged', comment: '' })}
      renderHeader={(f, set) => (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={td('branch')}><BranchSelect value={f.branchId} onChange={(v) => set({ branchId: v })} /></Field>
          <Field label={td('reason')}><Select value={f.reason} onChange={(e) => set({ reason: e.target.value })}>{WRITE_OFF_REASONS.map((r) => <option key={r} value={r}>{t(`reasons.${r}`)}</option>)}</Select></Field>
          <Field label={td('note')} className="md:col-span-2"><Input value={f.comment} onChange={(e) => set({ comment: e.target.value })} /></Field>
        </div>
      )}
      buildBody={(f, lines) => ({ branchId: f.branchId, reason: f.reason, comment: f.comment || undefined, lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty })) })}
      columns={[{ key: 'reason', header: td('reason'), render: (r: any) => t(`reasons.${r.reason}`) }, { key: 'total', header: t('lossValue'), align: 'right', render: (r: any) => m(r.total) }]}
      actions={(d) => [
        ...(d.status === 'draft' && ok ? [{ key: 'post', label: td('post'), path: `/write-offs/${d.id}/post`, variant: 'primary' as const }] : []),
        ...(d.status !== 'cancelled' && ok ? [{ key: 'cancel', label: td('cancel'), path: `/write-offs/${d.id}/cancel`, variant: 'danger' as const, needsReason: true }] : []),
      ]}
      detailExtra={(d) => <p>{t(`reasons.${d.reason}`)} · {t('lossValue')}: <b>{m(d.total)}</b> {d.comment && `· ${d.comment}`}</p>}
    />
  );
}
