'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, LogoMark, StarPattern } from '@/components/icons';
import { AnimatedNumber, Badge, Button, ConfirmModal, Field, Input, MoneyInput, Spinner, useToast } from '@/components/ui';
import { ThemeToggle } from '@/lib/theme';
import { CashModal, CloseShiftModal, CustomerModal, DiscountModal, DoneModal, HeldModal, PayModal, QtyModal, RefundModal, XReportModal, useErrText } from '@/components/pos/modals';
import { useAuth } from '@/lib/auth';
import { useMoney } from '@/lib/format';
import { usePos, type SellResult } from '@/lib/pos/store';
import * as store from '@/lib/pos/db';

type ModalName = null | 'qty' | 'discount' | 'customer' | 'held' | 'pay' | 'refund' | 'cashIn' | 'cashOut' | 'x' | 'close' | 'clear';

export default function PosPage() {
  const pos = usePos();
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const { logout, user, shop, can } = useAuth();

  if (pos.phase === 'loading') return <Centered><Spinner /></Centered>;

  if (pos.phase === 'choose-terminal') {
    return (
      <Centered>
        <Panel>
          <LogoMark size={44} />
          <h1 className="font-display text-xl font-semibold">{t('chooseTerminal')}</h1>
          {pos.terminals.length === 0 && <p className="text-muted">{t('noTerminals')}</p>}
          <div className="space-y-2">
            {pos.terminals.map((x, i) => (
              <button key={x.id} onClick={() => pos.chooseTerminal(x.id)} style={{ '--d': `${i * 70}ms` } as React.CSSProperties} className="anim-rise group flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md">
                <span className="flex items-center gap-3"><span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon name="terminals" /></span><span className="font-medium">{x.name}</span></span>
                {!x.paired && <Badge tone="warn">{t('notPaired')}</Badge>}
              </button>
            ))}
          </div>
          <Button variant="ghost" onClick={() => logout()}>{tc('logout')}</Button>
        </Panel>
      </Centered>
    );
  }

  if (!pos.catalogReady) {
    return (
      <Centered>
        <div className="space-y-2 text-center">
          <Spinner />
          <p>{t('loadingCatalog')}</p>
          {!pos.online && <p className="text-sm text-danger">{t('needOnlineFirst')}</p>}
        </div>
      </Centered>
    );
  }

  if (!pos.shift) return <OpenShift />;
  if (!pos.shift.mine && user?.role === 'cashier') return <OtherCashierShift />;
  void shop; void can;
  return <Register />;
}


function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      {children}
    </div>
  );
}

/** Card used by the full-screen steps before the register opens. */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="anim-pop relative isolate w-full max-w-md space-y-4 overflow-hidden rounded-2xl border border-border bg-surface p-7 shadow-lg">
      <div className="pointer-events-none absolute -right-16 -top-16 -z-10 h-56 w-56 text-primary/[0.09]"><StarPattern id="pos-panel" size={44} /></div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------------- shift */

function OpenShift() {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const pos = usePos();
  const err = useErrText();
  const { logout } = useAuth();
  const [cash, setCash] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = pos.fiscal?.enabled && !pos.fiscal.ok;
  const other = pos.shift && !pos.shift.mine;
  async function go() {
    setBusy(true); setError(null);
    try { await pos.openShift(cash ?? 0); } catch (e) { setError(err(e)); } finally { setBusy(false); }
  }
  return (
    <Centered>
      <Panel>
        <LogoMark size={44} />
        <div>
          <h1 className="font-display text-xl font-semibold">{t('openShift')}</h1>
          <p className="mt-0.5 text-sm font-medium text-primary">{pos.terminal?.name}</p>
        </div>
        <p className="text-sm text-muted">{t('noShiftNoSales')}</p>
        {!pos.online && <p className="rounded-lg bg-warn/12 p-2.5 text-sm text-warn">{t('offlineBanner')}</p>}
        {blocked && <p role="alert" className="rounded-lg bg-danger/10 p-2.5 text-sm text-danger">{t('fiscalDown')}</p>}
        <Field label={t('openingCash')}><MoneyInput autoFocus value={cash} onChange={setCash} onKeyDown={(e) => e.key === 'Enter' && !blocked && pos.online && go()} /></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button className="w-full" size="lg" loading={busy} disabled={!pos.online || !!blocked || !!other} onClick={go}>{t('openShift')}</Button>
        <div className="flex justify-between">
          {pos.terminals.length > 1 && <Button variant="ghost" size="sm" onClick={() => { try { localStorage.removeItem('kass.terminal'); } catch { /* ignore */ } location.reload(); }}>{t('menu.switchTerminal')}</Button>}
          <Button variant="ghost" size="sm" onClick={() => logout()}>{tc('logout')}</Button>
        </div>
      </Panel>
    </Centered>
  );
}

function OtherCashierShift() {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const pos = usePos();
  const { logout } = useAuth();
  return (
    <Centered>
      <Panel>
        <LogoMark size={44} />
        <p>{t('shiftOfOther', { name: pos.shift?.cashierName ?? '' })}</p>
        <Button variant="secondary" onClick={() => logout()}>{tc('logout')}</Button>
      </Panel>
    </Centered>
  );
}

/* ---------------------------------------------------------------------- register */

function Register() {
  const t = useTranslations('pos');
  const tc = useTranslations('common');
  const pos = usePos();
  const { logout, user, can } = useAuth();
  const { m } = useMoney();
  const toast = useToast();
  const err = useErrText();
  const [modal, setModal] = useState<ModalName>(null);
  const [done, setDone] = useState<SellResult | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<store.CatalogProduct[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const { priced, cart } = pos;
  const selLine = priced.lines.find((l) => l.key === sel) ?? priced.lines[priced.lines.length - 1];
  const fiscalBlocked = pos.fiscal?.enabled && !pos.fiscal.ok && !(pos.fiscal.supportsOffline && !pos.online);
  const canPay = priced.lines.length > 0 && priced.issues.length === 0 && !fiscalBlocked;

  // the last added line is selected
  useEffect(() => { if (cart.lines.length) setSel(cart.lines[cart.lines.length - 1].key); }, [cart.lines.length]);
  useEffect(() => { let alive = true; void store.searchProducts(q).then((r) => alive && setResults(r)); return () => { alive = false; }; }, [q]);

  const focusSearch = useCallback(() => { searchRef.current?.focus(); searchRef.current?.select(); }, []);
  useEffect(() => { if (!modal && !done) focusSearch(); }, [modal, done, focusSearch]);

  /* hot keys (spec 7.2) */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (modal || done) return;
      const map: Record<string, () => void> = {
        F1: focusSearch,
        F2: () => selLine && setModal('qty'),
        F4: () => cart.lines.length && setModal('discount'),
        F6: () => setModal('customer'),
        F8: () => void pos.hold(),
        F9: () => canPay && setModal('pay'),
        Escape: () => (q ? setQ('') : cart.lines.length && setModal('clear')),
      };
      const fn = map[e.key];
      if (fn) { e.preventDefault(); fn(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (document.activeElement === searchRef.current && results.length) return;
        const i = priced.lines.findIndex((l) => l.key === selLine?.key);
        const n = priced.lines[Math.min(priced.lines.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { e.preventDefault(); setSel(n.key); }
      } else if (e.key === 'Delete' && selLine && document.activeElement !== searchRef.current) pos.removeLine(selLine.key);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  });

  async function onSearchEnter() {
    const code = q.trim();
    if (!code) return;
    const exact = await store.findByBarcode(code);
    if (exact) await pos.scanBarcode(code);
    else if (results[0]) await pos.addById(results[0].id);
    else toast.error(t('unknownBarcode', { code }));
    setQ('');
  }

  async function doHold() { await pos.hold(); }

  return (
    <div className="flex h-screen flex-col bg-bg">
      {/* status bar */}
      <header className="relative z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/80 bg-surface/80 px-3 py-2 text-sm backdrop-blur-xl">
        <LogoMark size={32} />
        <div className="min-w-0 leading-tight">
          <div className="truncate font-display text-[0.85rem] font-semibold">{pos.shopInfo?.name}</div>
          <div className="truncate text-xs text-muted">{pos.branchInfo?.name} · {pos.terminal?.name} · {user?.fullName}</div>
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Badge dot tone={pos.online ? 'success' : 'danger'}>{pos.online ? t('online') : t('offline')}</Badge>
          <Badge dot tone={pos.agent.state === 'ready' ? (pos.agent.devices?.printer === 'error' ? 'warn' : 'success') : 'neutral'}>
            {pos.agent.state === 'ready' ? (pos.agent.devices?.printer === 'error' ? t('agent.printerError') : t('agent.ready')) : t(`agent.${pos.agent.state}`)}
          </Badge>
          {pos.queue.pending > 0 && <Badge tone="warn">{t('queued', { n: pos.queue.pending })}</Badge>}
          {pos.queue.failed > 0 && <Badge tone="danger">{t('queueFailed', { n: pos.queue.failed })}</Badge>}
          <ThemeToggle />
          <div className="relative">
            <Button size="sm" variant="secondary" className="h-9 w-9 !px-0" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="menu"><Icon name="menu" className="h-[18px] w-[18px]" /></Button>
            {menu && (
              <div role="menu" className="anim-pop absolute right-0 z-30 mt-2 w-60 rounded-xl border border-border bg-surface p-1.5 shadow-lg" onClick={() => setMenu(false)}>
                <MenuItem onClick={() => setModal('refund')}>{t('menu.refund')}</MenuItem>
                <MenuItem onClick={() => setModal('cashIn')}>{t('menu.cashIn')}</MenuItem>
                <MenuItem onClick={() => setModal('cashOut')}>{t('menu.cashOut')}</MenuItem>
                <MenuItem onClick={() => setModal('x')}>{t('menu.xReport')}</MenuItem>
                <MenuItem onClick={() => void pos.print('drawer.open', {}).catch((e) => toast.error(err(e)))}>{t('menu.drawer')}</MenuItem>
                <MenuItem onClick={() => void pos.syncNow()}>{t('menu.sync')}</MenuItem>
                {pos.shift?.mine && <MenuItem onClick={() => setModal('close')}>{t('menu.closeShift')}</MenuItem>}
                {can('reports.view') && <Link role="menuitem" className="block rounded-lg px-3 py-2 text-sm transition hover:bg-surface-2" href="/shop">{t('menu.backoffice')}</Link>}
                <MenuItem onClick={() => logout()}>{tc('logout')}</MenuItem>
              </div>
            )}
          </div>
        </span>
      </header>
      {!pos.online && <div className="anim-fade flex items-center justify-center gap-2 bg-warn/15 px-3 py-1.5 text-center text-sm text-warn"><Icon name="wifiOff" className="h-4 w-4" />{t('offlineBanner')}</div>}
      {fiscalBlocked && <div role="alert" className="bg-danger/15 px-3 py-1.5 text-center text-sm text-danger">{t('fiscalDown')}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[1fr_22rem] lg:overflow-visible">
        {/* left: search + lines */}
        <section className="flex min-h-[20rem] flex-col rounded-xl border border-border bg-surface shadow-sm lg:min-h-0">
          <div className="relative border-b border-border p-2.5">
            <Icon name="search" className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted" />
            <Input
              ref={searchRef}
              value={q}
              placeholder={pos.pendingMarked ? t('marking') : t('scanOrSearch')}
              onChange={(e) => setQ(e.target.value)}
              onKeyUp={(e) => setQ((e.target as HTMLInputElement).value) /* resync after a scanner burst wipes its own typing */}
              onKeyDown={(e) => { if (e.key === 'Enter') void onSearchEnter(); }}
              className={`h-12 pl-11 text-lg ${pos.pendingMarked ? 'ring-2 ring-warn' : ''}`}
              autoComplete="off"
            />
            {q && results.length > 0 && (
              <ul className="anim-pop absolute inset-x-2.5 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg">
                {results.map((p) => <SearchRow key={p.id} p={p} onPick={async () => { await pos.addById(p.id); setQ(''); focusSearch(); }} />)}
              </ul>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {priced.lines.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center text-muted">
                <span className="relative inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Icon name="search" className="h-7 w-7" /><span className="check-ring absolute inset-0 rounded-2xl border-2 border-primary/40" style={{ animationIterationCount: 'infinite', animationDuration: '2.8s' }} /></span>
                {t('emptyCart')}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2/95 text-left text-xs text-muted backdrop-blur">
                  <tr><th className="px-3 py-2.5 font-medium">{t('col.item')}</th><th className="px-2 text-right font-medium">{t('col.qty')}</th><th className="px-2 text-right font-medium">{t('col.price')}</th><th className="px-3 text-right font-medium">{t('col.sum')}</th><th /></tr>
                </thead>
                <tbody>
                  {priced.lines.map((l) => {
                    const disc = l.promoDiscount + l.manualDiscount + l.receiptShare;
                    const active = selLine?.key === l.key;
                    return (
                      <tr key={l.key} onClick={() => setSel(l.key)} className={`anim-row relative cursor-pointer border-t border-border transition-colors ${active ? 'bg-primary/10' : 'hover:bg-surface-2/60'}`}>
                        <td className="relative px-3 py-2.5">
                          {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary" />}
                          <div className="font-medium">{l.name}</div>
                          {l.promotionName && <div className="text-xs text-success">{l.promotionName}</div>}
                          {l.markingCode && <div className="text-xs text-muted">DM ✓</div>}
                        </td>
                        <td className="px-2 text-right tabular-nums">
                          <span className="inline-flex items-center gap-1">
                            <button className="h-8 w-8 rounded-lg bg-surface-2 text-base transition hover:bg-border active:scale-90" aria-label="-" onClick={(e) => { e.stopPropagation(); pos.setQty(l.key, l.qty - 1); }}>−</button>
                            <button className="min-w-11 rounded-lg px-1 py-1 font-semibold transition hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setSel(l.key); setModal('qty'); }}>{l.qty}</button>
                            <button className="h-8 w-8 rounded-lg bg-surface-2 text-base transition hover:bg-border active:scale-90" aria-label="+" onClick={(e) => { e.stopPropagation(); pos.setQty(l.key, l.qty + 1); }}>+</button>
                          </span>
                        </td>
                        <td className="px-2 text-right tabular-nums text-muted">{m(l.price)}</td>
                        <td className="px-3 text-right font-semibold tabular-nums">{disc > 0 && <div className="text-xs font-normal text-muted line-through">{m(l.gross)}</div>}{m(l.total)}</td>
                        <td className="pr-2"><button aria-label="remove" className="rounded-lg p-1.5 text-muted transition hover:bg-danger/10 hover:text-danger" onClick={(e) => { e.stopPropagation(); pos.removeLine(l.key); }}><Icon name="x" className="h-4 w-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <footer className="border-t border-border px-3 py-1.5 text-xs text-muted">{t('shortcuts')}</footer>
        </section>

        {/* right: totals + actions */}
        <aside className="flex flex-col gap-3">
          <button onClick={() => setModal('customer')} className="rounded-xl border border-border bg-surface p-3 text-left shadow-sm transition hover:border-primary/40 hover:bg-surface-2">
            <div className="flex items-center gap-1.5 text-xs text-muted"><Icon name="customers" className="h-3.5 w-3.5" />{t('customer')}</div>
            {pos.customer ? (
              <div>
                <div className="font-medium">{pos.customer.fullName}</div>
                <div className="flex gap-2 text-xs">{pos.customer.bonusBalance > 0 && <span className="text-success">{t('bonus', { n: m(pos.customer.bonusBalance) })}</span>}{pos.customer.debtBalance > 0 && <span className="text-danger">{t('debt', { n: m(pos.customer.debtBalance) })}</span>}</div>
              </div>
            ) : <div className="text-muted">{t('noCustomer')}</div>}
          </button>
          <div className="relative isolate overflow-hidden rounded-xl bg-gradient-to-br from-[#0b6f7c] via-primary-deep to-[#052f38] p-4 text-white shadow-md">
            <div className="pointer-events-none absolute -right-8 -top-10 -z-10 h-44 w-44 text-white/[0.09]"><div className="star-spin h-full w-full"><StarPattern id="pos-total" size={40} /></div></div>
            <div className="flex justify-between py-0.5 text-sm text-white/75"><span>{t('subtotal')}</span><span className="tabular-nums">{m(priced.subtotal)}</span></div>
            <div className="flex justify-between py-0.5 text-sm text-white/75"><span>{t('discounts')}</span><span className="tabular-nums">{priced.subtotal - priced.total > 0 ? `− ${m(priced.subtotal - priced.total)}` : m(0)}</span></div>
            <div className="mt-3 border-t border-white/20 pt-3">
              <div className="text-sm text-white/75">{t('toPay')}</div>
              <div className="font-display text-[2rem] font-semibold leading-tight tracking-tight tabular-nums"><AnimatedNumber value={priced.total} format={m} duration={380} /></div>
            </div>
            {priced.issues.length > 0 && <p role="alert" className="mt-2 rounded-lg bg-black/25 px-2 py-1 text-sm text-[#ffb4b4]">{priced.issues.map((i) => (i.code === 'PROMOTION_STACK' ? t('issue.stack') : t('issue.tooLarge'))).join(' ')}</p>}
            {pos.discountNeedsApproval && <p className="mt-2 text-xs text-accent">{t('needsApproval')}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setModal('discount')} disabled={!cart.lines.length}>F4 −%</Button>
            <Button variant="secondary" onClick={doHold} disabled={!cart.lines.length}>{t('hold')}</Button>
            <Button variant="secondary" onClick={() => setModal('held')}>{t('held')}{pos.heldCount > 0 ? ` (${pos.heldCount})` : ''}</Button>
            <Button variant="secondary" onClick={() => setModal('clear')} disabled={!cart.lines.length}>{t('clear')}</Button>
          </div>
          {/* phones / small tablets: the page scrolls, so the pay button stays pinned to the bottom edge */}
          <div className="sticky bottom-0 z-10 -mx-3 -mb-3 mt-auto bg-bg/95 px-3 pb-3 pt-2 backdrop-blur lg:static lg:mx-0 lg:mb-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <Button variant="accent" size="lg" className={`h-16 w-full text-xl font-semibold ${canPay ? 'anim-pulse' : ''}`} disabled={!canPay} onClick={() => setModal('pay')}>{t('pay')}</Button>
          </div>
        </aside>
      </div>

      <QtyModal open={modal === 'qty'} onClose={() => setModal(null)} initial={selLine?.qty ?? 1} unit={selLine?.unit ?? ''} isWeighted={!!selLine?.isWeighted} onSubmit={(n) => selLine && pos.setQty(selLine.key, n)} />
      <DiscountModal open={modal === 'discount'} onClose={() => setModal(null)} lineName={selLine?.name} currentLine={selLine?.manualDiscount ?? 0} currentReceipt={cart.receiptDiscount} onLine={(a) => selLine && pos.setLineDiscount(selLine.key, a)} onReceipt={pos.setReceiptDiscount} />
      <CustomerModal open={modal === 'customer'} onClose={() => setModal(null)} onPick={pos.setCustomer} />
      <HeldModal open={modal === 'held'} onClose={() => setModal(null)} />
      <PayModal open={modal === 'pay'} onClose={() => setModal(null)} onDone={(r) => { setModal(null); setDone(r); }} />
      <DoneModal result={done} onClose={() => { setDone(null); focusSearch(); }} />
      <RefundModal open={modal === 'refund'} onClose={() => setModal(null)} />
      <CashModal open={modal === 'cashIn'} type="in" onClose={() => setModal(null)} />
      <CashModal open={modal === 'cashOut'} type="out" onClose={() => setModal(null)} />
      <XReportModal open={modal === 'x'} onClose={() => setModal(null)} />
      <CloseShiftModal open={modal === 'close'} onClose={() => setModal(null)} />
      <ConfirmModal open={modal === 'clear'} onClose={() => setModal(null)} danger title={t('clear')} onConfirm={() => { pos.clearCart(); setModal(null); }} />
    </div>
  );
}

const MenuItem = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
  <button role="menuitem" className="block w-full rounded-lg px-3 py-2 text-left text-sm transition hover:bg-surface-2" onClick={onClick}>{children}</button>
);

function SearchRow({ p, onPick }: { p: store.CatalogProduct; onPick: () => void }) {
  const { m } = useMoney();
  const [price, setPrice] = useState<number | undefined>();
  useEffect(() => { void store.getPrice(p.id).then(setPrice); }, [p.id]);
  return (
    <li>
      <button className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition hover:bg-primary/10" onClick={onPick} disabled={price === undefined}>
        <span><span className="font-medium">{p.name}</span> <span className="text-xs text-muted">{p.barcodes[0]}</span></span>
        <span className="tabular-nums">{price === undefined ? '—' : m(price)}</span>
      </button>
    </li>
  );
}
