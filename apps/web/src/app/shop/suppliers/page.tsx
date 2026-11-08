'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PAYMENT_METHODS } from '@kass/shared';
import { CrudPage } from '@/components/crud';
import { Badge, Button, DataTable, Field, FormError, Input, Modal, MoneyInput, Select, useToast } from '@/components/ui';
import { api, post, qs } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, useMoney } from '@/lib/format';

export default function SuppliersPage() {
  const t = useTranslations('shop.suppliers');
  const tc = useTranslations('common');
  const { can } = useAuth();
  const { m } = useMoney();
  const [statement, setStatement] = useState<any>(null);
  const [pay, setPay] = useState<any>(null);
  const [debtOnly, setDebtOnly] = useState(false);
  return (
    <>
      <CrudPage<any>
        title={t('title')}
        endpoint="/suppliers"
        queryKey="suppliers"
        canWrite={can('suppliers.manage')}
        extraParams={{ debtOnly: debtOnly ? 'true' : undefined }}
        headerActions={<Button variant={debtOnly ? 'primary' : 'secondary'} onClick={() => setDebtOnly(!debtOnly)}>{t('debtOnly')}</Button>}
        emptyForm={{ name: '', contactPerson: '', phone: '', address: '', tin: '', paymentTermDays: 0, note: '', isActive: true }}
        fromRow={(r) => ({ name: r.name, contactPerson: r.contactPerson ?? '', phone: r.phone ?? '', address: r.address ?? '', tin: r.tin ?? '', paymentTermDays: r.paymentTermDays, note: r.note ?? '', isActive: r.isActive })}
        toBody={(f) => ({ name: f.name, contactPerson: f.contactPerson || undefined, phone: f.phone || undefined, address: f.address || undefined, tin: f.tin || undefined, paymentTermDays: Number(f.paymentTermDays) || 0, note: f.note || undefined, isActive: f.isActive })}
        fields={[
          { key: 'name', label: tc('name'), required: true },
          { key: 'contactPerson', label: t('contact') },
          { key: 'phone', label: tc('phone'), type: 'tel' },
          { key: 'tin', label: t('tin') },
          { key: 'address', label: t('address'), span: 2 },
          { key: 'paymentTermDays', label: t('paymentTerm'), type: 'number' },
          { key: 'isActive', label: tc('active'), type: 'checkbox' },
          { key: 'note', label: tc('note'), type: 'textarea', span: 2 },
        ]}
        columns={[
          { key: 'name', header: tc('name'), render: (r) => <div><span className="font-medium">{r.name}</span><div className="text-xs text-muted">{r.contactPerson} {r.phone}</div></div> },
          { key: 'paymentTermDays', header: t('paymentTerm'), align: 'right' },
          { key: 'balance', header: t('balance'), align: 'right', render: (r) => (r.balance > 0 ? <Badge tone="danger">{m(r.balance)}</Badge> : r.balance < 0 ? <Badge tone="info">{m(r.balance)}</Badge> : m(0)) },
        ]}
        rowActions={(r) => <><Button size="sm" variant="secondary" onClick={() => setStatement(r)}>{t('statement')}</Button>{can('suppliers.pay') && <Button size="sm" variant="secondary" onClick={() => setPay(r)}>{t('pay')}</Button>}</>}
      />
      <StatementModal supplier={statement} onClose={() => setStatement(null)} />
      <PayModal supplier={pay} onClose={() => setPay(null)} />
    </>
  );
}

function StatementModal({ supplier, onClose }: { supplier: any; onClose: () => void }) {
  const t = useTranslations('shop.suppliers');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const [f, setF] = useState({ from: '', to: '' });
  const { data } = useQuery({ queryKey: ['statement', supplier?.id, f], queryFn: () => api<any>(`/suppliers/${supplier.id}/statement` + qs({ from: f.from ? new Date(f.from).toISOString() : '', to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : '' })), enabled: !!supplier });
  return (
    <Modal open={!!supplier} onClose={onClose} wide title={`${t('statement')}: ${supplier?.name ?? ''}`} footer={<Button onClick={onClose}>{tc('close')}</Button>}>
      <div className="mb-3 flex gap-2"><Field label={tc('from')}><Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field><Field label={tc('to')}><Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>
      {data && <>
        <p className="mb-2 text-sm">{t('opening')}: <b>{m(data.openingBalance)}</b> · {t('closing')}: <b>{m(data.closingBalance)}</b></p>
        <DataTable rows={data.entries} rowKey={(_, i) => String(i)} columns={[
          { key: 'date', header: tc('date'), render: (r: any) => fmtDateTime(r.date) },
          { key: 'type', header: t('type'), render: (r: any) => t(`entry.${r.type}`) },
          { key: 'docNumber', header: t('document') },
          { key: 'amount', header: tc('amount'), align: 'right', render: (r: any) => m(r.amount) },
          { key: 'balance', header: t('balance'), align: 'right', render: (r: any) => m(r.balance) },
        ]} />
      </>}
    </Modal>
  );
}

function PayModal({ supplier, onClose }: { supplier: any; onClose: () => void }) {
  const t = useTranslations('shop.suppliers');
  const tc = useTranslations('common');
  const tm = useTranslations('sa.method');
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<{ amount: number | null; method: string; comment: string; paidAt: string }>({ amount: null, method: 'cash', comment: '', paidAt: fmtDate(new Date()) });
  const run = useMutation({ mutationFn: () => post('/supplier-payments', { supplierId: supplier.id, amount: f.amount, method: f.method, comment: f.comment || undefined, paidAt: new Date(f.paidAt).toISOString() }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['suppliers'] }); toast.ok(tc('saved')); onClose(); } });
  return (
    <Modal open={!!supplier} onClose={onClose} title={`${t('pay')}: ${supplier?.name ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={run.isPending} disabled={!f.amount} onClick={() => run.mutate()}>{tc('save')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tc('amount')} hint={t('partialHint')}><MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
        <Field label={t('method')}><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAYMENT_METHODS.map((x) => <option key={x} value={x}>{tm(x)}</option>)}</Select></Field>
        <Field label={tc('date')}><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
        <Field label={tc('comment')}><Input value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} /></Field>
      </div>
      <FormError error={run.error} />
    </Modal>
  );
}
