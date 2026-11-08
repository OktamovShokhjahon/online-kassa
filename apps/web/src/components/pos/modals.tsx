'use client';

import { inventoryEnabled } from '@kass/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, post } from '@/lib/api';
import { useMoney } from '@/lib/format';
import { fmtDateTime } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { checkPayments, maxBonusPayable, type PaymentInput } from '@/lib/pos/cart';
import * as store from '@/lib/pos/db';
import { usePos, type SellResult } from '@/lib/pos/store';
import { Badge, Button, Field, Input, Modal, MoneyInput, Select, Textarea, useToast } from '@/components/ui';

/** Server messages are already translated; local error codes are looked up in `errors.*`. */
export function useErrText() {
  const te = useTranslations('errors');
  return (e: unknown): string => {
    if (e instanceof ApiError) return e.message && e.message !== e.code ? e.message : te.has(e.code as any) ? te(e.code as any) : e.code;
    return (e as Error)?.message ?? String(e);
  };
}

const Row = ({ label, value, strong, tone }: { label: ReactNode; value: ReactNode; strong?: boolean; tone?: 'danger' | 'success' }) => (
  <div className={`flex items-center justify-between py-1 ${strong ? 'text-lg font-semibold' : 'text-sm'} ${tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : ''}`}>
    <span className={strong ? '' : 'text-muted'}>{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

/* ----------------------------------------------------------------------- numbers */

export function QtyModal({ open, onClose, initial, unit, isWeighted, onSubmit }: { open: boolean; onClose: () => void; initial: number; unit: string; isWeighted: boolean; onSubmit: (qty: number) => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const [v, setV] = useState(String(initial));
  useEffect(() => { if (open) setV(String(initial)); }, [open, initial]);
  const submit = () => {
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    onSubmit(isWeighted ? Math.round(n * 1000) / 1000 : Math.round(n));
    onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={t('setQty')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button onClick={submit}>{tc('confirm')}</Button></>}>
      <Field label={unit}>
        <Input autoFocus inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} className="text-2xl" />
      </Field>
    </Modal>
  );
}

export function DiscountModal({ open, onClose, lineName, currentLine, currentReceipt, onLine, onReceipt }: { open: boolean; onClose: () => void; lineName?: string; currentLine: number; currentReceipt: number; onLine: (amount: number) => void; onReceipt: (amount: number) => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const [line, setLine] = useState<number | null>(currentLine);
  const [receipt, setReceipt] = useState<number | null>(currentReceipt);
  useEffect(() => { if (open) { setLine(currentLine); setReceipt(currentReceipt); } }, [open, currentLine, currentReceipt]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('discounts')}
      footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button onClick={() => { if (lineName) onLine(line ?? 0); onReceipt(receipt ?? 0); onClose(); }}>{tc('confirm')}</Button></>}
    >
      <div className="space-y-3">
        {lineName && <Field label={`${t('lineDiscount')} — ${lineName}`}><MoneyInput value={line} onChange={setLine} /></Field>}
        <Field label={t('receiptDiscount')} hint={t('discountAmount')}><MoneyInput value={receipt} onChange={setReceipt} /></Field>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------- customer */

export function CustomerModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (c: store.CatalogCustomer | null) => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { can } = useAuth();
  const { m } = useMoney();
  const { online } = usePos();
  const err = useErrText();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [list, setList] = useState<store.CatalogCustomer[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ fullName: '', phone: '+998' });
  useEffect(() => { if (open) { setQ(''); setCreating(false); } }, [open]);
  useEffect(() => { if (open) void store.searchCustomers(q).then(setList); }, [q, open]);

  async function create() {
    try {
      const c = await post('/customers', form);
      onPick({ id: c.id ?? String(c._id), fullName: c.fullName, phone: c.phone, bonusBalance: 0, debtBalance: 0 });
      onClose();
    } catch (e) { toast.error(err(e)); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('customer')} wide footer={<Button variant="secondary" onClick={() => { onPick(null); onClose(); }}>{t('noCustomer')}</Button>}>
      {creating ? (
        <div className="space-y-3">
          <Field label={t('fullName')}><Input autoFocus value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label={tc('phone')}><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <div className="flex gap-2"><Button onClick={create} disabled={!form.fullName || form.phone.length < 9}>{tc('create')}</Button><Button variant="secondary" onClick={() => setCreating(false)}>{tc('back')}</Button></div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex gap-2">
            <Input autoFocus placeholder={t('customerSearch')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { onPick(list[0]); onClose(); } }} />
            {online && can('customers.create') && <Button variant="secondary" onClick={() => setCreating(true)}>{t('newCustomer')}</Button>}
          </div>
          <ul className="divide-y divide-border">
            {list.map((c) => (
              <li key={c.id}>
                <button className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition hover:bg-primary/10" onClick={() => { onPick(c); onClose(); }}>
                  <span><span className="font-medium">{c.fullName}</span> <span className="text-sm text-muted">{c.phone}</span></span>
                  <span className="flex gap-2 text-xs">{c.bonusBalance > 0 && <Badge tone="success">{t('bonus', { n: m(c.bonusBalance) })}</Badge>}{c.debtBalance > 0 && <Badge tone="danger">{t('debt', { n: m(c.debtBalance) })}</Badge>}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------------ held */

export function HeldModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('pos');
  const { m } = useMoney();
  const { resume } = usePos();
  const [list, setList] = useState<store.HeldCart[]>([]);
  useEffect(() => { if (open) void store.listHeld().then(setList); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={t('held')}>
      {list.length === 0 ? <p className="text-muted">{t('noHeld')}</p> : (
        <ul className="divide-y divide-border">
          {list.map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2">
              <div><div className="font-medium">{h.label}</div><div className="text-xs text-muted">{fmtDateTime(h.at)} · {h.cart.lines.length} × · {m(h.cart.lines.reduce((s, l) => s + Math.round(l.qty * l.price), 0))}</div></div>
              <Button size="sm" onClick={async () => { await resume(h.id); onClose(); }}>{t('resume')}</Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------------- payment */

export function PayModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: SellResult) => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { can } = useAuth();
  const { m } = useMoney();
  const { priced, customer, online, shopInfo, sell, discountNeedsApproval } = usePos();
  const err = useErrText();
  const total = priced.total;
  const [cash, setCash] = useState<number | null>(null);
  const [card, setCard] = useState<number | null>(null);
  const [bonus, setBonus] = useState<number | null>(null);
  const [credit, setCredit] = useState<number | null>(null);
  const [approval, setApproval] = useState({ login: '', pin: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => { if (open) { setCash(null); setCard(null); setBonus(null); setCredit(null); setApproval({ login: '', pin: '' }); setError(null); } }, [open]);

  const maxPct = shopInfo?.settings?.loyalty?.maxPayPercent ?? 0;
  const bonusMax = customer ? maxBonusPayable(total, customer.bonusBalance, maxPct) : 0;
  const canCredit = !!customer && online && can('sales.credit');
  const canBonus = !!customer && online && bonusMax > 0;
  const nonCash = (card ?? 0) + (bonus ?? 0) + (credit ?? 0);
  const cashDue = Math.max(0, total - nonCash);
  const received = cash ?? cashDue;
  const payments: PaymentInput[] = useMemo(
    () => [...(cashDue > 0 ? [{ method: 'cash' as const, amount: received }] : []), ...(card ? [{ method: 'card' as const, amount: card }] : []), ...(bonus ? [{ method: 'bonus' as const, amount: bonus }] : []), ...(credit ? [{ method: 'credit' as const, amount: credit }] : [])],
    [cashDue, received, card, bonus, credit],
  );
  const chk = checkPayments(total, payments);
  const change = chk.ok ? chk.change : 0;
  const needApproval = discountNeedsApproval && online;

  async function submit() {
    if (busyRef.current || !chk.ok) return; // double Enter must not sell twice
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await sell(payments, { approval: needApproval ? approval : null });
      onDone(r);
    } catch (e) {
      setError(err(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // F12 completes the sale from anywhere in the dialog
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'F12') { e.preventDefault(); void submit(); } };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('payment')}
      wide
      footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!chk.ok || (needApproval && (!approval.login || approval.pin.length < 4))} onClick={submit}>{t('completeSale')}</Button></>}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-3 rounded-xl bg-gradient-to-br from-[#0b6f7c] via-primary-deep to-[#052f38] p-4 text-center text-white shadow-md">
            <div className="text-sm text-white/75">{t('toPay')}</div>
            <div className="font-display text-3xl font-semibold tabular-nums">{m(total)}</div>
          </div>
          <Row label={t('remaining')} value={m(Math.max(0, cashDue - received))} tone={received < cashDue ? 'danger' : undefined} />
          <Row label={t('change')} value={m(change)} strong tone={change > 0 ? 'success' : undefined} />
          {needApproval && (
            <div className="mt-3 space-y-2 rounded-xl border border-warn/60 bg-warn/5 p-3">
              <div className="text-sm font-medium">{t('approval')}</div>
              <p className="text-xs text-muted">{t('needsApproval')}</p>
              <Input placeholder={t('approvalLogin')} value={approval.login} onChange={(e) => setApproval({ ...approval, login: e.target.value })} />
              <Input placeholder={t('approvalPin')} type="password" inputMode="numeric" maxLength={6} value={approval.pin} onChange={(e) => setApproval({ ...approval, pin: e.target.value.replace(/\D/g, '') })} />
            </div>
          )}
          {error && <p role="alert" className="mt-3 rounded-lg border border-danger/25 bg-danger/10 p-2.5 text-sm text-danger">{error}</p>}
        </div>
        <div className="space-y-3">
          <Field label={t('method.cash')}>
            <div className="flex gap-2">
              <MoneyInput value={cash ?? cashDue} onChange={setCash} disabled={cashDue === 0} />
              <Button variant="secondary" onClick={() => setCash(null)}>{t('exact')}</Button>
            </div>
          </Field>
          <Field label={t('method.card')}>
            <div className="flex gap-2"><MoneyInput value={card} onChange={(v) => { setCard(v); setCash(null); }} /><Button variant="secondary" onClick={() => { setCard(Math.max(0, total - (bonus ?? 0) - (credit ?? 0))); setCash(null); }}>{t('toPay')}</Button></div>
          </Field>
          {canBonus && (
            <Field label={`${t('method.bonus')} (≤ ${m(bonusMax)})`}>
              <div className="flex gap-2"><MoneyInput value={bonus} onChange={(v) => { setBonus(v === null ? null : Math.min(v, bonusMax)); setCash(null); }} /><Button variant="secondary" onClick={() => { setBonus(bonusMax); setCash(null); }}>{t('toPay')}</Button></div>
            </Field>
          )}
          {canCredit && (
            <Field label={t('method.credit')}>
              <MoneyInput value={credit} onChange={(v) => { setCredit(v); setCash(null); }} />
            </Field>
          )}
          {!chk.ok && <p className="text-sm text-danger">{err(new ApiError(422, chk.error, chk.error))}</p>}
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------------- receipt */

export function DoneModal({ result, onClose }: { result: SellResult | null; onClose: () => void }) {
  const t = useTranslations('pos');
  const { m } = useMoney();
  const { print } = usePos();
  const err = useErrText();
  const [msg, setMsg] = useState<string | null>(null);
  const [reprinted, setReprinted] = useState(false);
  useEffect(() => { setMsg(null); setReprinted(false); }, [result]);
  useEffect(() => {
    if (!result) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [result, onClose]);
  if (!result) return null;
  return (
    <Modal open onClose={onClose} title={t('saleDone')} footer={<><Button variant="secondary" onClick={async () => { try { await print('print.receipt', { receipt: { ...result.receipt, copy: true }, copies: 1 }); setMsg(null); setReprinted(true); } catch (e) { setMsg(err(e)); } }}>{t('reprint')}</Button><Button onClick={onClose}>{t('newSale')}</Button></>}>
      <div className="space-y-1.5 text-center">
        <div className="relative mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-success/15 text-success">
          <span className="check-ring absolute inset-0 rounded-full border-2 border-success/50" />
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path className="check-draw" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </div>
        <div className="text-sm text-muted">№ {result.number}</div>
        <div className="font-display text-3xl font-semibold tabular-nums">{m(result.receipt.total)}</div>
        {result.change > 0 && <div className="text-xl font-medium text-success">{t('change')}: {m(result.change)}</div>}
        {result.offline && <Badge tone="warn">{t('savedOffline')}</Badge>}
        {(msg || (result.printError && !reprinted)) && <p role="alert" className="text-sm text-danger">{t('printFailed', { error: msg ?? result.printError ?? '' })}</p>}
        {result.warnings.length > 0 && (
          <div className="mt-2 rounded-lg bg-surface-2 p-2.5 text-left text-xs"><div className="font-medium">{t('warnings')}</div>{result.warnings.map((w: any, i: number) => <div key={i}>{w.message ?? w.code}</div>)}</div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------ refund */

export function RefundModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const { online, shift, print } = usePos();
  const err = useErrText();
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [sale, setSale] = useState<any>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'cash' | 'card' | 'debt'>('cash');
  const [restock, setRestock] = useState<'stock' | 'writeoff'>('stock');
  const [approval, setApproval] = useState({ login: '', pin: '' });
  const [needApproval, setNeedApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setNumber(''); setSale(null); setQty({}); setReason(''); setError(null); setNeedApproval(false); setApproval({ login: '', pin: '' }); } }, [open]);

  async function find() {
    setError(null);
    try {
      const s = await api(`/sales/by-number/${encodeURIComponent(number.trim())}`);
      setSale(s);
      setQty({});
      setMethod(s.payments?.some((p: any) => p.method === 'card') && !s.payments?.some((p: any) => p.method === 'cash') ? 'card' : 'cash');
    } catch (e) { setSale(null); setError(e instanceof ApiError && e.status === 404 ? t('refund.notFound') : err(e)); }
  }

  const chosen = sale ? sale.lines.map((l: any, i: number) => ({ l, i, q: qty[i] ?? 0 })).filter((x: any) => x.q > 0) : [];
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/refunds', {
        saleId: sale.id ?? sale._id,
        lines: chosen.map((x: any) => ({ productId: String(x.l.productId), lineIndex: x.i, qty: x.q })),
        reason, method, restock,
        clientRequestId: crypto.randomUUID(),
        approval: needApproval ? approval : undefined,
      });
      toast.ok(t('refund.done', { amount: m(r.payout ?? r.total ?? 0) }));
      if (r.receipt) void print('print.receipt', { receipt: r.receipt, copies: 1 }).catch(() => undefined);
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_INVALID') setNeedApproval(true);
      setError(err(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('refund.title')} wide footer={sale && <><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!chosen.length || reason.trim().length < 2 || !shift} onClick={submit}>{t('refund.submit')}</Button></>}>
      {!online ? <p className="text-danger">{t('refund.offlineBlocked')}</p> : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input autoFocus placeholder={t('refund.number')} value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && number && find()} />
            <Button onClick={find} disabled={!number}>{t('refund.find')}</Button>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          {sale && (
            <>
              <div className="text-sm text-muted">№ {sale.number} · {fmtDateTime(sale.createdAt)} · {m(sale.total)}</div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-muted"><th>{t('col.item')}</th><th className="text-right">{t('refund.sold')}</th><th className="w-28 text-right">{t('refund.returnQty')}</th></tr></thead>
                <tbody>
                  {sale.lines.map((l: any, i: number) => {
                    const left = Math.round((l.qty - (l.refundedQty ?? 0)) * 1000) / 1000;
                    return (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1">{l.name}</td>
                        <td className="text-right tabular-nums">{l.qty}{l.refundedQty ? ` (−${l.refundedQty})` : ''}</td>
                        <td className="text-right">
                          <Input className="w-24 text-right" inputMode="decimal" disabled={left <= 0} value={qty[i] ?? ''} placeholder="0" onChange={(e) => { const n = Number(e.target.value.replace(',', '.')); setQty({ ...qty, [i]: Number.isFinite(n) ? Math.min(Math.max(0, n), left) : 0 }); }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Field label={t('refund.reason')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('refund.method')}>
                  <Select value={method} onChange={(e) => setMethod(e.target.value as any)}>
                    <option value="cash">{t('method.cash')}</option><option value="card">{t('method.card')}</option>{sale.customerId && <option value="debt">{t('refund.debtMethod')}</option>}
                  </Select>
                </Field>
                {inventoryEnabled() && <Field label={t('refundGoods')}>
                  <Select value={restock} onChange={(e) => setRestock(e.target.value as any)}>
                    <option value="stock">{t('refund.restock')}</option><option value="writeoff">{t('refund.writeoff')}</option>
                  </Select>
                </Field>}
              </div>
              {needApproval && (
                <div className="space-y-2 rounded-xl border border-warn/60 bg-warn/5 p-3">
                  <div className="text-sm font-medium">{t('approval')}</div>
                  <Input placeholder={t('approvalLogin')} value={approval.login} onChange={(e) => setApproval({ ...approval, login: e.target.value })} />
                  <Input placeholder={t('approvalPin')} type="password" inputMode="numeric" maxLength={6} value={approval.pin} onChange={(e) => setApproval({ ...approval, pin: e.target.value.replace(/\D/g, '') })} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- cash in / out */

export function CashModal({ open, onClose, type }: { open: boolean; onClose: () => void; type: 'in' | 'out' }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { shift, online, refreshShift } = usePos();
  const err = useErrText();
  const toast = useToast();
  const [amount, setAmount] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setAmount(null); setComment(''); setError(null); } }, [open]);
  async function submit() {
    setBusy(true);
    try {
      await post('/cash-operations', { shiftId: shift!.id, type, amount, comment });
      toast.ok(t('cash.done'));
      await refreshShift();
      onClose();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={type === 'in' ? t('menu.cashIn') : t('menu.cashOut')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!online || !amount || !comment.trim()} onClick={submit}>{tc('confirm')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('cash.amount')}><MoneyInput autoFocus value={amount} onChange={setAmount} /></Field>
        <Field label={t('cash.comment')}><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------- X-report */

export function XReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('pos');
  const { m } = useMoney();
  const { shift, print } = usePos();
  const err = useErrText();
  const [data, setData] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !shift) return;
    setData(null); setMsg(null);
    api(`/shifts/${shift.id}/x-report`).then(setData).catch((e) => setMsg(err(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift?.id]);
  const tt = data?.totals;
  return (
    <Modal open={open} onClose={onClose} title={t('xReport')} footer={<Button disabled={!data} onClick={async () => { try { await print('print.report', { report: data.report }); } catch (e) { setMsg(err(e)); } }}>{t('printReport')}</Button>}>
      {msg && <p role="alert" className="text-sm text-danger">{msg}</p>}
      {tt && (
        <div>
          <Row label={t('close.receipts')} value={tt.receipts} />
          <Row label={t('close.sales')} value={m(tt.net ?? 0)} />
          <Row label={t('method.cash')} value={m(tt.byMethod?.cash ?? 0)} />
          <Row label={t('method.card')} value={m(tt.byMethod?.card ?? 0)} />
          <Row label={t('close.expected')} value={m(tt.expectedCash ?? 0)} strong />
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ close shift */

export function CloseShiftModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { m } = useMoney();
  const { shift, closeShift, print, queue, online, syncNow } = usePos();
  const err = useErrText();
  const toast = useToast();
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [totals, setTotals] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !shift) return;
    setCounted(null); setNote(''); setError(null); setTotals(null);
    void syncNow().then(() => api(`/shifts/${shift.id}/x-report`)).then((r) => setTotals(r.totals)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift?.id]);
  const expected = totals?.expectedCash ?? 0;
  const diff = (counted ?? 0) - expected;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await closeShift(counted ?? 0, note || undefined);
      toast.ok(t('close.closed'));
      if (r?.report) void print('print.report', { report: r.report }).catch(() => undefined);
      void print('drawer.open', {}).catch(() => undefined);
      onClose();
    } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }
  const unsent = queue.pending + queue.failed;
  return (
    <Modal open={open} onClose={onClose} title={t('close.title')} footer={<><Button variant="secondary" onClick={onClose}>{tc('cancel')}</Button><Button loading={busy} disabled={!online || counted === null || unsent > 0} onClick={submit}>{t('close.submit')}</Button></>}>
      <div className="space-y-3">
        {unsent > 0 && <p role="alert" className="rounded-lg bg-warn/12 p-2.5 text-sm text-warn">{t('close.unsent', { n: unsent })}</p>}
        <Row label={t('close.receipts')} value={totals?.receipts ?? '…'} />
        <Row label={t('close.expected')} value={totals ? m(expected) : '…'} strong />
        <Field label={t('close.counted')}><MoneyInput autoFocus value={counted} onChange={setCounted} /></Field>
        {counted !== null && totals && <Row label={t('close.difference')} value={m(diff)} tone={diff === 0 ? 'success' : 'danger'} />}
        <Field label={tc('note')}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
