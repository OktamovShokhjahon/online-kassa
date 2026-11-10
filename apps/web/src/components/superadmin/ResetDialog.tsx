'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RESET_GROUPS, withResetDependencies, type ResetGroup } from '@kass/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { Button, FormError, Input, Modal, Spinner, cx, useToast } from '@/components/ui';
import { api, post } from '@/lib/api';

/**
 * Superadmin: choose what to wipe from a shop. Groups another choice depends on are ticked and
 * locked automatically; the shop name has to be typed before anything is deleted.
 */
export function ResetDialog({ shopId, open, onClose }: { shopId: string; open: boolean; onClose: () => void }) {
  const t = useTranslations('sa.reset');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<ResetGroup[]>([]);
  const [name, setName] = useState('');
  const preview = useQuery({ queryKey: ['sa-shop-reset', shopId], queryFn: () => api<{ shopName: string; groups: Array<{ group: ResetGroup; main: number; total: number }> }>(`/admin/shops/${shopId}/reset`), enabled: open });
  useEffect(() => { if (open) { setChosen([]); setName(''); } }, [open]);

  const effective = useMemo(() => withResetDependencies(chosen), [chosen]);
  /** Groups ticked only because another chosen group needs them, with who needs them. */
  const neededBy = (g: ResetGroup) => chosen.filter((c) => c !== g && withResetDependencies([c]).includes(g));
  const toggle = (g: ResetGroup) => setChosen((c) => (c.includes(g) ? c.filter((x) => x !== g) : [...c, g]));
  const all = chosen.length === RESET_GROUPS.length;
  const shopName = preview.data?.shopName ?? '';
  const nameOk = !!shopName && name.trim().toLowerCase() === shopName.trim().toLowerCase();
  const totalToDelete = (preview.data?.groups ?? []).filter((x) => effective.includes(x.group)).reduce((s, x) => s + x.total, 0);

  const run = useMutation({
    mutationFn: () => post<{ groups: ResetGroup[]; deleted: Record<string, number> }>(`/admin/shops/${shopId}/reset`, { groups: chosen, confirmName: name }),
    onSuccess: (r) => {
      const n = Object.values(r.deleted).reduce((s, x) => s + x, 0);
      toast.ok(t('done', { n }));
      for (const k of ['sa-shop', 'sa-shops', 'sa-shop-stats', 'sa-shop-users', 'sa-shop-reset']) qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={t('title')}
      footer={<>
        <Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button>
        <Button variant="danger" loading={run.isPending} disabled={!chosen.length || !nameOk} onClick={() => run.mutate()}>{t('delete', { n: totalToDelete })}</Button>
      </>}
    >
      <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{t('warning')}</p>
      {preview.isLoading ? <Spinner /> : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">{t('choose')}</span>
            <Button size="sm" variant="ghost" onClick={() => setChosen(all ? [] : [...RESET_GROUPS])}>{all ? t('none') : t('all')}</Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {RESET_GROUPS.map((g) => {
              const row = preview.data?.groups.find((x) => x.group === g);
              const on = effective.includes(g);
              const forced = on && !chosen.includes(g);
              const by = forced ? neededBy(g) : [];
              return (
                <label
                  key={g}
                  className={cx(
                    'flex cursor-pointer gap-3 rounded-lg border p-3 transition',
                    on ? 'border-danger/60 bg-danger/5' : 'border-border hover:bg-surface-2',
                    forced && 'cursor-default',
                  )}
                >
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--danger))]" checked={on} disabled={forced} onChange={() => toggle(g)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{t(`groups.${g}.name`)}</span>
                      <span className="tabular shrink-0 text-xs text-muted">{t('records', { n: row?.main ?? 0 })}</span>
                    </span>
                    <span className="block text-xs text-muted">{t(`groups.${g}.what`)}</span>
                    {forced && <span className="mt-1 block text-xs text-danger">{t('neededBy', { list: by.map((x) => t(`groups.${x}.name`)).join(', ') })}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted">{t('stays')}</p>
          <label className="mt-4 block space-y-1.5">
            <span className="block text-sm">{t('typeName')} <b className="select-all font-mono">{shopName}</b></span>
            <Input value={name} autoComplete="off" onChange={(e) => setName(e.target.value)} placeholder={shopName} className={cx(name && !nameOk && 'border-danger')} />
          </label>
        </>
      )}
      <FormError error={preview.error || run.error} />
    </Modal>
  );
}
