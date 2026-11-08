'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { CrudPage } from '@/components/crud';
import { Badge, Button, Card, DataTable, Field, FormError, Modal, MoneyInput, Select, Stat, useToast } from '@/components/ui';
import { api, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, useMoney } from '@/lib/format';

export default function CustomersPage() {
  const t = useTranslations('shop.customers');
  const tc = useTranslations('common');
  const { can } = useAuth();
  const { m } = useMoney();
  const [history, setHistory] = useState<any>(null);
  const [repay, setRepay] = useState<any>(null);
  const [debtOnly, setDebtOnly] = useState(false);
  const manage = can('customers.manage');
  return (
    <>
      <CrudPage<any>
        title={t('title')}
        endpoint="/customers"
        queryKey="customers"
        canWrite={manage || can('customers.create')}
        canEditRow={() => manage}
        extraParams={{ debtOnly: debtOnly ? 'true' : undefined }}
        headerActions={<Button variant={debtOnly ? 'primary' : 'secondary'} onClick={() => setDebtOnly(!debtOnly)}>{t('debtors')}</Button>}
        emptyForm={{ fullName: '', phone: '+998 ', cardBarcode: '', birthday: '', note: '', creditLimit: null }}
        fromRow={(r) => ({ fullName: r.fullName, phone: r.phone, cardBarcode: r.cardBarcode ?? '', birthday: fmtDate(r.birthday), note: r.note ?? '', creditLimit: r.creditLimit })}
        toBody={(f) => ({ fullName: f.fullName, phone: f.phone, cardBarcode: f.cardBarcode || undefined, birthday: f.birthday ? new Date(f.birthday).toISOString() : undefined, note: f.note || undefined, ...(manage && f.creditLimit !== null ? { creditLimit: f.creditLimit } : {}) })}
        fields={[
          { key: 'fullName', label: t('fullName'), required: true },
          { key: 'phone', label: tc('phone'), type: 'tel', required: true },
          { key: 'cardBarcode', label: t('card'), hint: t('cardHint') },
          { key: 'birthday', label: t('birthday'), type: 'date' },
          ...(manage ? [{ key: 'creditLimit', label: t('creditLimit'), type: 'money' as const, hint: t('creditHint') }] : []),
          { key: 'note', label: tc('note'), type: 'textarea', span: 2 },
        ]}
        columns={[
          { key: 'fullName', header: t('fullName'), render: (r) => <div><span className="font-medium">{r.fullName}</span><div className="text-xs text-muted">{r.phone}</div></div> },
          { key: 'bonusBalance', header: t('bonus'), align: 'right', render: (r) => m(r.bonusBalance) },
          { key: 'debtBalance', header: t('debt'), align: 'right', render: (r) => (r.debtBalance > 0 ? <Badge tone="danger">{m(r.debtBalance)}</Badge> : m(0)) },
          { key: 'totalSpent', header: t('spent'), align: 'right', render: (r) => m(r.totalSpent) },
          { key: 'lastVisitAt', header: t('lastVisit'), render: (r) => fmtDate(r.lastVisitAt) },
        ]}
        rowActions={(r) => <><Button size="sm" variant="secondary" onClick={() => setHistory(r)}>{t('history')}</Button>{r.debtBalance > 0 && manage && <Button size="sm" variant="secondary" onClick={() => setRepay(r)}>{t('repay')}</Button>}</>}
      />
      <HistoryModal customer={history} onClose={() => setHistory(null)} />
      <RepayModal customer={repay} onClose={() => setRepay(null)} />
    </>
  );
}

function HistoryModal({ customer, onClose }: { customer: any; onClose: () => void }) {
  const t = useTranslations('shop.customers');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const { data } = useQuery({ queryKey: ['customer-history', customer?.id], queryFn: () => api<any>(`/customers/${customer.id}/history?limit=50`), enabled: !!customer });
  return (
    <Modal open={!!customer} onClose={onClose} wide title={customer?.fullName ?? ''} footer={<Button onClick={onClose}>{tc('close')}</Button>}>
      {data && <>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('spent')} value={m(data.stats.totalSpent)} /><Stat label={t('receipts')} value={data.stats.receipts} /><Stat label={t('average')} value={m(data.stats.averageReceipt)} /><Stat label={t('lastVisit')} value={fmtDate(data.stats.lastVisitAt) || '—'} />
        </div>
        <Card title={t('purchases')}><DataTable rows={data.sales} columns={[{ key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) }, { key: 'number', header: tc('name') }, { key: 'total', header: tc('total'), align: 'right', render: (r: any) => m(r.total) }, { key: 'status', header: tc('status') }]} /></Card>
        <Card title={t('bonusLedger')} className="mt-3"><DataTable rows={data.bonus} columns={[{ key: 'createdAt', header: tc('date'), render: (r: any) => fmtDateTime(r.createdAt) }, { key: 'type', header: t('type') }, { key: 'amount', header: tc('amount'), align: 'right', render: (r: any) => m(r.amount) }]} /></Card>
      </>}
    </Modal>
  );
}

function RepayModal({ customer, onClose }: { customer: any; onClose: () => void }) {
  const t = useTranslations('shop.customers');
  const tc = useTranslations('common');
  const toast = useToast();
  const qc = useQueryClient();
  const { m } = useMoney();
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState('cash');
  const run = useMutation({ mutationFn: () => post('/customer-payments', { customerId: customer.id, amount, method }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); toast.ok(tc('saved')); onClose(); } });
  return (
    <Modal open={!!customer} onClose={onClose} title={`${t('repay')}: ${customer?.fullName ?? ''}`} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={run.isPending} disabled={!amount} onClick={() => run.mutate()}>{tc('save')}</Button></>}>
      <p className="mb-3 text-sm">{t('debt')}: <b>{m(customer?.debtBalance ?? 0)}</b></p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={tc('amount')}><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label={t('method')}><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">{t('cash')}</option><option value="card">{t('card2')}</option></Select></Field>
      </div>
      <p className="mt-2 text-xs text-muted">{t('repayNote')}</p>
      <FormError error={run.error} />
    </Modal>
  );
}
