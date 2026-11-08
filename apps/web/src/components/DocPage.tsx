'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Badge, Button, DataTable, FormError, Input, Modal, PageHeader, Pagination, Select, Textarea, useToast, type Column } from '@/components/ui';
import { api, apiPage, post, qs } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { LineEditor, type DocLine } from './docs';
import { BranchSelect } from './pickers';

const TONE: Record<string, 'neutral' | 'success' | 'danger' | 'warn' | 'info'> = { draft: 'neutral', posted: 'success', sent: 'info', received: 'success', cancelled: 'danger' };

export interface DocPageProps {
  ns: string;
  title: string;
  endpoint: string;
  /** Extra form fields rendered above the lines. */
  renderHeader: (form: any, set: (p: any) => void) => ReactNode;
  blankForm: () => any;
  buildBody: (form: any, lines: DocLine[]) => Record<string, unknown>;
  lineMode: 'qty' | 'cost' | 'count';
  columns: Column<any>[];
  /** Workflow buttons for a document in the detail modal. */
  actions: (doc: any) => Array<{ key: string; label: string; path: string; body?: object; variant?: 'primary' | 'danger' | 'secondary'; needsReason?: boolean; /** Opens the quantity-check dialog (transfers). */ receive?: boolean }>;
  canCreate: boolean;
  statuses: string[];
  mapLines?: (doc: any) => DocLine[];
  detailExtra?: (doc: any) => ReactNode;
  /** Whether a created draft is posted immediately by the "post" button. */
  postAction?: { label: string; path: string; body?: object };
}

/**
 * List + create (draft / post) + detail with state-machine buttons, shared by goods receipts,
 * supplier returns, transfers, write-offs and stock counts.
 */
export function DocPage(p: DocPageProps) {
  const tc = useTranslations('common');
  const td = useTranslations('shop.docs');
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ branchId: '', status: '', page: 1 });
  const [creating, setCreating] = useState<{ form: any; lines: DocLine[] } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<{ path: string; label: string } | null>(null);
  const [reason, setReason] = useState('');
  const [receiving, setReceiving] = useState<{ path: string; lines: Array<{ productId: string; name: string; sent: number }> } | null>(null);
  const [recvQty, setRecvQty] = useState<Record<string, string>>({});
  const [recvNote, setRecvNote] = useState('');

  const list = useQuery({ queryKey: [p.endpoint, f], queryFn: () => apiPage<any>(p.endpoint + qs({ ...f, limit: 20 })) });
  const detail = useQuery({ queryKey: [p.endpoint, 'detail', openId], queryFn: () => api<any>(`${p.endpoint}/${openId}`), enabled: !!openId });
  const reload = () => { qc.invalidateQueries({ queryKey: [p.endpoint] }); qc.invalidateQueries({ queryKey: ['stock'] }); };

  const create = useMutation({
    mutationFn: ({ post: doPost }: { post: boolean }) => post(p.endpoint, { ...p.buildBody(creating!.form, creating!.lines), ...(doPost && p.postAction === undefined ? { post: true } : {}) }),
    onSuccess: async (doc, vars) => {
      if (vars.post && p.postAction) await post(p.postAction.path.replace(':id', doc.id), p.postAction.body ?? {});
      reload(); setCreating(null); toast.ok(tc('saved'));
    },
  });
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => post(path, body ?? {}),
    onSuccess: () => { reload(); setReasonFor(null); setReason(''); setReceiving(null); setRecvNote(''); qc.invalidateQueries({ queryKey: [p.endpoint, 'detail', openId] }); toast.ok(tc('saved')); },
    onError: toast.error,
  });

  const doc = detail.data;
  return (
    <>
      <PageHeader title={p.title} actions={p.canCreate && <Button onClick={() => { create.reset(); setCreating({ form: p.blankForm(), lines: [] }); }}>{tc('create')}</Button>} />
      <div className="mb-3 flex gap-2">
        <BranchSelect all className="w-48" value={f.branchId} onChange={(v) => setF({ ...f, branchId: v, page: 1 })} />
        <Select className="w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">{tc('status')}: {tc('all')}</option>{p.statuses.map((s) => <option key={s} value={s}>{td(`status.${s}`)}</option>)}</Select>
      </div>
      <DataTable loading={list.isLoading} rows={list.data?.data} onRowClick={(r) => setOpenId(r.id)} columns={[
        { key: 'number', header: '№', render: (r: any) => <span className="font-mono">{r.number}</span> },
        ...p.columns,
        { key: 'status', header: tc('status'), render: (r: any) => <Badge tone={TONE[r.status]}>{td(`status.${r.status}`)}</Badge> },
        { key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) },
      ]} />
      {list.data && <Pagination page={list.data.meta.page} limit={list.data.meta.limit} total={list.data.meta.total} onPage={(page) => setF({ ...f, page })} />}

      <Modal open={!!creating} wide onClose={() => setCreating(null)} title={p.title} footer={<><Button variant="secondary" onClick={() => setCreating(null)}>{tc('cancel')}</Button><Button variant="secondary" loading={create.isPending} disabled={!creating?.lines.length} onClick={() => create.mutate({ post: false })}>{td('saveDraft')}</Button><Button loading={create.isPending} disabled={!creating?.lines.length} onClick={() => create.mutate({ post: true })}>{p.postAction?.label ?? td('post')}</Button></>}>
        {creating && (
          <div className="space-y-4">
            {p.renderHeader(creating.form, (patch) => setCreating((c) => (c ? { ...c, form: { ...c.form, ...patch } } : c)))}
            <LineEditor mode={p.lineMode} lines={creating.lines} onChange={(lines) => setCreating((c) => (c ? { ...c, lines } : c))} />
            <FormError error={create.error} />
          </div>
        )}
      </Modal>

      <Modal open={!!openId} wide onClose={() => setOpenId(null)} title={doc ? `${doc.number}` : ''} footer={doc && <>
        {p.actions(doc).map((a) => <Button key={a.key} variant={a.variant ?? 'secondary'} loading={act.isPending} onClick={() => {
          const path = a.path.replace(':id', doc.id);
          if (a.receive) {
            const lines = doc.lines.map((l: any) => ({ productId: String(l.productId), name: l.productName ?? String(l.productId), sent: l.qtySent ?? l.qty }));
            setRecvQty(Object.fromEntries(lines.map((l: any) => [l.productId, String(l.sent)])));
            setReceiving({ path, lines });
          } else if (a.needsReason) setReasonFor({ path, label: a.label });
          else act.mutate({ path, body: a.body });
        }}>{a.label}</Button>)}
        <Button onClick={() => setOpenId(null)}>{tc('close')}</Button>
      </>}>
        {doc && (
          <div className="space-y-3 text-sm">
            <p><Badge tone={TONE[doc.status]}>{td(`status.${doc.status}`)}</Badge> {doc.cancelReason && <span className="ml-2 text-muted">{td('reason')}: {doc.cancelReason}</span>}</p>
            {p.detailExtra?.(doc)}
            <LineEditor readOnly mode={p.lineMode === 'count' ? 'count' : p.lineMode} lines={(p.mapLines ? p.mapLines(doc) : doc.lines.map((l: any) => ({ product: { id: l.productId, name: l.productName ?? l.productId, barcode: l.barcode }, qty: l.qty ?? l.qtySent, cost: l.cost ?? l.unitCost, counted: l.counted })))} onChange={() => undefined} />
          </div>
        )}
      </Modal>
      <Modal
        open={!!receiving}
        wide
        onClose={() => setReceiving(null)}
        title={td('receivedQty')}
        footer={<><Button variant="secondary" onClick={() => setReceiving(null)}>{tc('cancel')}</Button><Button loading={act.isPending} onClick={() => act.mutate({ path: receiving!.path, body: { lines: receiving!.lines.map((l) => ({ productId: l.productId, qtyReceived: Math.max(0, Number((recvQty[l.productId] ?? '').replace(',', '.')) || 0) })), note: recvNote || undefined } })}>{tc('confirm')}</Button></>}
      >
        {receiving && (
          <div className="space-y-3">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted"><th>{tc('name')}</th><th className="text-right">{td('sentQty')}</th><th className="w-32 text-right">{td('receivedQty')}</th></tr></thead>
              <tbody>
                {receiving.lines.map((l) => {
                  const diff = Number((recvQty[l.productId] ?? '').replace(',', '.')) !== l.sent;
                  return (
                    <tr key={l.productId} className="border-t border-border">
                      <td className="py-1">{l.name}</td>
                      <td className="text-right tabular-nums">{l.sent}</td>
                      <td className="text-right"><Input className={`w-28 text-right ${diff ? 'border-warn' : ''}`} inputMode="decimal" value={recvQty[l.productId] ?? ''} onChange={(e) => setRecvQty({ ...recvQty, [l.productId]: e.target.value })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Textarea rows={2} placeholder={td('receiveNote')} value={recvNote} onChange={(e) => setRecvNote(e.target.value)} />
          </div>
        )}
      </Modal>
      <Modal open={!!reasonFor} onClose={() => setReasonFor(null)} title={reasonFor?.label ?? ''} footer={<><Button variant="secondary" onClick={() => setReasonFor(null)}>{tc('cancel')}</Button><Button variant="danger" loading={act.isPending} disabled={reason.trim().length < 2} onClick={() => act.mutate({ path: reasonFor!.path, body: { reason } })}>{tc('confirm')}</Button></>}>
        <Textarea placeholder={td('reasonRequired')} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Modal>
    </>
  );
}
