'use client';

import { useTranslations } from 'next-intl';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PromotionDef } from '@kass/shared';
import { ApiError, api, post } from '@/lib/api';
import { useToast } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { AgentClient, type AgentState, type DeviceStatus } from './agent';
import { addProduct, checkPayments, emptyCart, manualDiscountPercent, priceCart, removeLine, setLineDiscount, setQty, type Cart, type PaymentInput, type Priced } from './cart';
import * as store from './db';
import { buildLocalReceipt, buildSaleBody } from './sale';
import { attachScanner } from './scanner';
import { sounds } from './sounds';

export interface Shift { id: string; terminalId: string; cashierId: string; cashierName?: string; openingCash: number; openedAt: string; mine: boolean; totals?: any; status: string }
export interface Terminal { id: string; name: string; branchId: string; paired: boolean; online: boolean }
export type SellResult = { receipt: any; change: number; warnings: any[]; offline: boolean; number: string; printError?: string };

interface Pos {
  phase: 'loading' | 'choose-terminal' | 'ready';
  terminals: Terminal[];
  terminal: Terminal | null;
  chooseTerminal: (id: string) => Promise<void>;
  online: boolean;
  shift: Shift | null;
  refreshShift: () => Promise<void>;
  openShift: (openingCash: number) => Promise<void>;
  closeShift: (countedCash: number, note?: string) => Promise<any>;
  cart: Cart;
  priced: Priced;
  promotions: PromotionDef[];
  shopInfo: any;
  branchInfo: any;
  heldCount: number;
  queue: { pending: number; failed: number };
  agent: { state: AgentState; devices: DeviceStatus | null };
  fiscal: { enabled: boolean; ok: boolean; supportsOffline: boolean; message?: string } | null;
  catalogReady: boolean;
  // cart operations
  scanBarcode: (code: string, markingCode?: string) => Promise<'added' | 'unknown' | 'noprice' | 'marking'>;
  addById: (productId: string) => Promise<boolean>;
  pendingMarked: { productId: string } | null;
  setQty: (key: string, qty: number) => void;
  setLineDiscount: (key: string, amount: number) => void;
  setReceiptDiscount: (amount: number) => void;
  removeLine: (key: string) => void;
  clearCart: () => void;
  setCustomer: (c: any | null) => void;
  customer: any | null;
  hold: (label?: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  // sale
  sell: (payments: PaymentInput[], opts?: { approval?: { login: string; pin: string } | null }) => Promise<SellResult>;
  print: (type: 'print.receipt' | 'print.report' | 'drawer.open' | 'print.test', payload: unknown) => Promise<void>;
  lastReceipt: any | null;
  syncNow: () => Promise<void>;
  discountNeedsApproval: boolean;
}

const Ctx = createContext<Pos | null>(null);
export const usePos = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePos outside PosProvider');
  return v;
};

const isNetworkError = (e: unknown) => !(e instanceof ApiError);

export function PosProvider({ children }: { children: ReactNode }) {
  const { user, shop, can } = useAuth();
  const toast = useToast();
  const tp = useTranslations('pos');
  const [phase, setPhase] = useState<Pos['phase']>('loading');
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [shift, setShift] = useState<Shift | null>(null);
  const [cart, setCart] = useState<Cart>(emptyCart());
  const [customer, setCustomerState] = useState<any | null>(null);
  const [promotions, setPromotions] = useState<PromotionDef[]>([]);
  const [shopInfo, setShopInfo] = useState<any>(null);
  const [branchInfo, setBranchInfo] = useState<any>(null);
  const [heldCount, setHeldCount] = useState(0);
  const [queue, setQueue] = useState({ pending: 0, failed: 0 });
  const [agent, setAgent] = useState<{ state: AgentState; devices: DeviceStatus | null }>({ state: 'offline', devices: null });
  const [fiscal, setFiscal] = useState<Pos['fiscal']>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<any | null>(null);
  const [pendingMarked, setPendingMarked] = useState<{ productId: string } | null>(null);
  const agentRef = useRef<AgentClient | null>(null);
  const scanHandler = useRef<(c: string) => void>(() => undefined);
  const syncing = useRef(false);

  const priced = useMemo(() => priceCart(cart, promotions, terminal?.branchId ?? ''), [cart, promotions, terminal]);
  const discountNeedsApproval = !can('sales.discount') && manualDiscountPercent(priced) > (shop?.settings.maxCashierDiscount ?? 0) + 1e-9;

  /* ------------------------------------------------------------------- connectivity */
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    // a captive network can report "online" while the server is unreachable: ping as well
    const t = setInterval(async () => {
      try { const r = await fetch('/api/v1/health', { cache: 'no-store' }); setOnline(r.ok); } catch { setOnline(false); }
    }, 10_000);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); clearInterval(t); };
  }, []);

  /* ---------------------------------------------------------------------- catalog */
  const refreshLocal = useCallback(async () => {
    setPromotions(((await store.getMeta<PromotionDef[]>('promotions')) ?? []).map((p) => ({ ...p })));
    setShopInfo(await store.getMeta('shop'));
    setBranchInfo(await store.getMeta('branch'));
    const q = await store.listQueue();
    setQueue({ pending: q.filter((x) => x.status === 'pending').length, failed: q.filter((x) => x.status === 'failed').length });
    setHeldCount((await store.listHeld()).length);
  }, []);

  const syncCatalog = useCallback(async (t: Terminal, full = false) => {
    // a catalog downloaded for another branch must never be topped up incrementally
    const sameBranch = (await store.getMeta<string>('catalogBranch')) === t.branchId;
    const since = full || !sameBranch ? undefined : await store.getMeta<string>('serverTime');
    const feed = await api(`/pos/catalog?terminalId=${t.id}${since ? `&since=${encodeURIComponent(since)}` : ''}`);
    await store.applyCatalog(feed);
    await store.setMeta('catalogBranch', t.branchId);
    await refreshLocal();
    setCatalogReady(true);
  }, [refreshLocal]);

  /* -------------------------------------------------------------------- shift/fiscal */
  const refreshShift = useCallback(async () => {
    if (!terminal) return;
    try {
      const s = await api(`/shifts/current?terminalId=${terminal.id}`);
      setShift(s);
      await store.setMeta('shift', s);
    } catch (e) {
      if (isNetworkError(e)) setShift((await store.getMeta<Shift>('shift')) ?? null); // offline: keep the shift we know
    }
  }, [terminal]);

  const refreshFiscal = useCallback(async (t: Terminal) => {
    if (!shop?.fiscalEnabled) return setFiscal({ enabled: false, ok: true, supportsOffline: true });
    try {
      const st = await api(`/fiscal/status/${t.id}`);
      const f = { enabled: true, ok: !!st.online, supportsOffline: !!st.supportsOffline, message: st.message };
      setFiscal(f);
      await store.setMeta('fiscal', f);
    } catch {
      setFiscal((await store.getMeta('fiscal')) ?? { enabled: true, ok: false, supportsOffline: false });
    }
  }, [shop?.fiscalEnabled]);

  /* ------------------------------------------------------------------ queue sync */
  const syncNow = useCallback(async () => {
    if (syncing.current || !terminal) return;
    syncing.current = true;
    try {
      const items = (await store.listQueue()).filter((s) => s.status === 'pending').slice(0, 25);
      if (items.length) {
        const results: any[] = await api('/sales/sync', { method: 'POST', json: { sales: items.map((i) => i.payload) } });
        for (const r of results) {
          const item = items.find((i) => i.clientRequestId === r.clientRequestId);
          if (!item) continue;
          if (r.status === 'created' || r.status === 'duplicate') await store.removeQueued(item.clientRequestId);
          else await store.updateQueued({ ...item, status: 'failed', attempts: item.attempts + 1, error: { code: r.error?.code ?? 'ERROR', message: r.error?.message ?? '' } });
        }
      }
      await refreshLocal();
      await api('/pos/status', { method: 'PUT', json: { terminalId: terminal.id, pendingOffline: await store.queueCount() } }).catch(() => undefined);
    } catch {
      /* still offline: try again later */
    } finally {
      syncing.current = false;
    }
  }, [terminal, refreshLocal]);

  useEffect(() => {
    if (!online || !terminal) return;
    void syncNow().then(() => syncCatalog(terminal).catch(() => undefined));
    void refreshShift();
    void refreshFiscal(terminal);
    const t = setInterval(() => { void syncNow(); void syncCatalog(terminal).catch(() => undefined); }, 3 * 60_000); // "every few minutes"
    return () => clearInterval(t);
  }, [online, terminal, syncNow, syncCatalog, refreshShift, refreshFiscal]);

  /* ---------------------------------------------------------------------- boot */
  useEffect(() => {
    if (!user) return;
    (async () => {
      let list: Terminal[] = [];
      try { list = await api('/terminals'); await store.setMeta('terminals', list); } catch { list = ((await store.getMeta<Terminal[]>('terminals')) ?? []); }
      setTerminals(list);
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('kass.terminal') : null;
      const pick = list.find((t) => t.id === saved) ?? (list.length === 1 ? list[0] : null);
      if (pick) await choose(pick, list);
      else setPhase('choose-terminal');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function choose(t: Terminal, list = terminals) {
    setTerminal(t);
    try { localStorage.setItem('kass.terminal', t.id); } catch { /* ignore */ }
    const c = await store.getMeta<Cart>('cart');
    if (c) setCart(c);
    setCustomerState((await store.getMeta('customer')) ?? null);
    await refreshLocal();
    setCatalogReady(!!(await store.getMeta('serverTime')) && (await store.getMeta<string>('catalogBranch')) === t.branchId);
    setPhase('ready');
    void list;
  }
  const chooseTerminal = async (id: string) => { const t = terminals.find((x) => x.id === id); if (t) await choose(t); };

  /* ---------------------------------------------------------------- agent + scanner */
  useEffect(() => {
    if (!terminal) return;
    const a = new AgentClient(terminal.id, { onState: (state, devices) => setAgent({ state, devices }), onScan: (code) => scanHandler.current(code) });
    agentRef.current = a;
    a.start();
    return () => { a.stop(); agentRef.current = null; };
  }, [terminal]);
  useEffect(() => attachScanner({ onScan: (code) => scanHandler.current(code) }), []);

  // the open cart survives a browser refresh
  useEffect(() => { if (phase === 'ready') void store.setMeta('cart', cart); }, [cart, phase]);
  useEffect(() => { if (phase === 'ready') void store.setMeta('customer', customer); }, [customer, phase]);

  /* ------------------------------------------------------------------ cart actions */
  const toLine = (p: store.CatalogProduct, price: number) => ({ productId: p.id, name: p.name, barcode: p.barcodes[0], unit: p.unit, price, vatRate: p.vatRate, isWeighted: p.isWeighted, isMarked: p.isMarked, categoryIds: p.categoryIds });

  const addProductToCart = useCallback(async (p: store.CatalogProduct, markingCode?: string): Promise<'added' | 'noprice' | 'marking'> => {
    const price = await store.getPrice(p.id);
    if (price === undefined) { sounds.error(); toast.error(tp('noPrice')); return 'noprice'; }
    if (p.isMarked && !markingCode) { setPendingMarked({ productId: p.id }); return 'marking'; }
    setCart((c) => {
      const next = addProduct(c, toLine(p, price));
      if (p.isMarked) next.lines[next.lines.length - 1].markingCode = markingCode;
      return next;
    });
    sounds.ok();
    return 'added';
  }, [toast, tp]);

  const scanBarcode: Pos['scanBarcode'] = useCallback(async (code, markingCode) => {
    // while a marked product waits for its DataMatrix code, the next scan IS that code
    if (pendingMarked && !markingCode) {
      const p = await store.getProduct(pendingMarked.productId);
      setPendingMarked(null);
      if (p) return addProductToCart(p, code);
    }
    const p = await store.findByBarcode(code);
    if (!p || !p.isActive) { sounds.unknown(); toast.error(tp('unknownBarcode', { code })); return 'unknown'; }
    return addProductToCart(p, markingCode);
  }, [pendingMarked, addProductToCart, toast, tp]);
  scanHandler.current = (c) => void scanBarcode(c);

  const addById: Pos['addById'] = async (id) => {
    const p = await store.getProduct(id);
    return p ? (await addProductToCart(p)) === 'added' : false;
  };

  const logRemoved = (items: Array<{ name: string; qty: number; price?: number; reason: string }>) => {
    if (!shift || !online || !items.length) return;
    void api(`/shifts/${shift.id}/removed-lines`, { method: 'POST', json: { items } }).catch(() => undefined);
  };

  const ops = {
    setQty: (key: string, qty: number) => {
      const l = cart.lines.find((x) => x.key === key);
      if (l && qty < l.qty) logRemoved([{ name: l.name, qty: l.qty - qty, price: l.price, reason: 'qty_decreased' }]);
      setCart((c) => (qty <= 0 ? removeLine(c, key) : setQty(c, key, qty)));
    },
    setLineDiscount: (key: string, amount: number) => setCart((c) => setLineDiscount(c, key, amount)),
    setReceiptDiscount: (amount: number) => setCart((c) => ({ ...c, receiptDiscount: Math.max(0, Math.round(amount)) })),
    removeLine: (key: string) => {
      const l = cart.lines.find((x) => x.key === key);
      if (l) logRemoved([{ name: l.name, qty: l.qty, price: l.price, reason: 'line_removed' }]);
      setCart((c) => removeLine(c, key));
    },
    clearCart: () => {
      logRemoved(cart.lines.map((l) => ({ name: l.name, qty: l.qty, price: l.price, reason: 'cart_cleared' })));
      setCart(emptyCart());
      setCustomerState(null);
    },
  };

  const hold = async (label?: string) => {
    if (!cart.lines.length) return;
    await store.holdCart({ id: crypto.randomUUID(), at: new Date().toISOString(), cart, label: label || customer?.fullName || `#${(await store.listHeld()).length + 1}` });
    setCart(emptyCart());
    setCustomerState(null);
    await refreshLocal();
  };
  const resume = async (id: string) => {
    const h = (await store.listHeld()).find((x) => x.id === id);
    if (!h) return;
    if (cart.lines.length) await hold(); // park what is on screen first
    setCart(h.cart);
    await store.dropHeld(id);
    await refreshLocal();
  };

  /* -------------------------------------------------------------------- shifts */
  const openShift = async (openingCash: number) => {
    const s = await post('/shifts/open', { terminalId: terminal!.id, openingCash });
    setShift({ ...s, mine: true });
  };
  const closeShift = async (countedCash: number, note?: string) => {
    await syncNow();
    const unsent = await store.queueCount();
    const r = await post(`/shifts/${shift!.id}/close`, { countedCash, unsentOfflineCount: unsent, note });
    setShift(null);
    return r;
  };

  /* ------------------------------------------------------------------- printing */
  const print: Pos['print'] = async (type, payload) => {
    const a = agentRef.current;
    if (a) return a.print(type, payload);
    throw new Error('Agent not started');
  };

  /* ------------------------------------------------------------------------ sale */
  const sell: Pos['sell'] = async (payments, opts) => {
    if (!terminal || !shift) throw new ApiError(422, 'NO_OPEN_SHIFT', 'No open shift');
    if (priced.issues.length) throw new ApiError(422, priced.issues[0].code, priced.issues[0].code);
    const chk = checkPayments(priced.total, payments);
    if (!chk.ok) throw new ApiError(422, chk.error, chk.error);
    const clientRequestId = crypto.randomUUID();
    const merged = (['cash', 'card', 'bonus', 'credit'] as const).map((method) => ({ method, amount: payments.filter((p) => p.method === method).reduce((s, p) => s + p.amount, 0) })).filter((p) => p.amount > 0);
    const body = buildSaleBody({ clientRequestId, terminalId: terminal.id, shiftId: shift.id, lines: priced.lines, receiptDiscount: cart.receiptDiscount, payments: merged, customerId: customer?.id, approval: opts?.approval });
    const cashGiven = merged.find((p) => p.method === 'cash')?.amount ?? 0;

    const finish = async (receipt: any, offline: boolean, number: string, warnings: any[]): Promise<SellResult> => {
      setLastReceipt(receipt);
      setCart(emptyCart());
      setCustomerState(null);
      sounds.done();
      let printError: string | undefined;
      try { await print('print.receipt', { receipt, copies: 1 }); } catch (e: any) { printError = e?.message ?? 'print failed'; }
      return { receipt, change: chk.change, warnings, offline, number, printError };
    };

    if (online) {
      try {
        const res = await api('/sales', { method: 'POST', json: body });
        return await finish(res.receipt, false, res.number, res.warnings ?? []);
      } catch (e) {
        if (!isNetworkError(e)) throw e; // the server answered: show its message
        setOnline(false); // the request may or may not have arrived: the SAME clientRequestId makes the retry safe
      }
    }

    // ------------------------------------------------------------- offline path (spec 7.6)
    if (merged.some((p) => p.method === 'bonus' || p.method === 'credit')) throw new ApiError(422, 'OFFLINE_NOT_ALLOWED', 'OFFLINE_NOT_ALLOWED');
    if (opts?.approval || discountNeedsApproval) throw new ApiError(422, 'OFFLINE_NOT_ALLOWED', 'OFFLINE_NOT_ALLOWED');
    if (shopInfo?.fiscalEnabled && !fiscal?.supportsOffline) throw new ApiError(422, 'OFFLINE_NOT_ALLOWED', 'OFFLINE_NOT_ALLOWED');
    const localNumber = await store.nextLocalNumber(terminal.id);
    const createdAt = new Date();
    const offlineBody = buildSaleBody({ clientRequestId, terminalId: terminal.id, shiftId: shift.id, lines: priced.lines, receiptDiscount: cart.receiptDiscount, payments: merged, customerId: customer?.id, offline: true, localNumber, createdAt });
    const receipt = buildLocalReceipt({ shop: { ...shopInfo, settings: shopInfo.settings }, branch: branchInfo ?? {}, terminalName: terminal.name, cashierName: user?.fullName ?? '', number: localNumber, createdAt, lines: priced.lines, subtotal: priced.subtotal, discount: priced.promoTotal + priced.manualTotal, total: priced.total, payments: chk.applied, cashGiven, change: chk.change });
    await store.enqueueSale({ clientRequestId, terminalId: terminal.id, shiftId: shift.id, localNumber, createdAt: createdAt.toISOString(), payload: offlineBody, receipt, status: 'pending', attempts: 0, total: priced.total });
    await refreshLocal();
    return finish(receipt, true, localNumber, []);
  };

  const value: Pos = {
    phase, terminals, terminal, chooseTerminal, online, shift, refreshShift, openShift, closeShift, cart, priced, promotions, shopInfo, branchInfo, heldCount, queue, agent, fiscal, catalogReady,
    scanBarcode, addById, pendingMarked, ...ops, setCustomer: setCustomerState, customer, hold, resume, sell, print, lastReceipt, syncNow, discountNeedsApproval,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
