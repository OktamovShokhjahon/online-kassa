'use client';

import { useTranslations } from 'next-intl';
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';
import { HelpLine, HelpTip, useFieldHelp } from './help';
import { Icon, StarMark, StarPattern } from './icons';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
/** Fields fill their container unless the caller sets a width. */
/**
 * Fields are full width unless the page gives a width. A wide fixed width (filter bars: w-36 and up)
 * still becomes full width on phones, so filters stack neatly instead of overflowing.
 */
const fill = (className?: string) => {
  const cls = className ?? '';
  if (!/(^|\s)w-/.test(cls)) return 'w-full';
  const m = /(?:^|\s)w-(\d+)(?=\s|$)/.exec(cls);
  return m && Number(m[1]) >= 36 ? 'max-sm:!w-full' : '';
};

/* -------------------------------------------------------------------------- buttons */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent'; size?: 'sm' | 'md' | 'lg'; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'primary', size = 'md', loading, className, children, disabled, ...p }, ref) {
  const v = {
    primary: 'bg-gradient-to-b from-primary to-primary/90 text-primary-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_14px_-6px_rgb(var(--primary)/0.75)] hover:brightness-110',
    accent: 'bg-gradient-to-b from-accent to-accent/90 text-[#241600] shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_8px_18px_-8px_rgb(var(--accent)/0.9)] hover:brightness-105',
    secondary: 'border border-border bg-surface text-fg shadow-sm hover:bg-surface-2',
    danger: 'bg-danger text-danger-fg shadow-[0_6px_14px_-6px_rgb(var(--danger)/0.7)] hover:brightness-110',
    ghost: 'text-fg hover:bg-surface-2',
  }[variant];
  const s = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' }[size];
  return (
    <button ref={ref} disabled={disabled || loading} className={cx('inline-flex select-none items-center justify-center gap-2 rounded-lg font-medium transition duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100', v, s, className)} {...p}>
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return <span role="status" aria-label="loading" className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent', className ?? 'h-5 w-5 text-primary')} />;
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" className={cx('skeleton', className)} style={style} />;
}

/* --------------------------------------------------------------------------- fields */

const inputCls = 'rounded-lg border border-border bg-surface px-3 text-sm text-fg shadow-sm transition placeholder:text-muted/80 hover:border-muted/50 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx(inputCls, fill(className), 'h-10', className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx(inputCls, fill(className), 'py-2', className)} rows={3} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cx(inputCls, fill(className), 'h-10', className)} {...p}>
      {children}
    </select>
  );
});

/**
 * Checkbox with its label. When the label has a help entry (lib/help.ts), a "?" with the longer
 * explanation sits after the label and the short definition under it. `help={false}` turns it off.
 */
export function Checkbox({ label, className, help: helpKey, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; help?: string | false }) {
  const id = useId();
  const found = useFieldHelp(label, typeof helpKey === 'string' ? helpKey : undefined);
  const help = helpKey === false ? null : found;
  return (
    <div className={cx('flex flex-col gap-0.5', className)}>
      <span className="flex items-center gap-2 text-sm">
        <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
          <input id={id} type="checkbox" className="h-4 w-4 cursor-pointer rounded accent-[rgb(var(--primary))]" {...p} />
          {label}
        </label>
        {help && <HelpTip title={label} help={help} />}
      </span>
      {help && <span className="pl-6 text-xs text-muted">{help.short}</span>}
    </div>
  );
}

/**
 * Label + control + the line under it. That line shows the page's `hint`, or else the short
 * definition from the help dictionary (found from the label automatically), with a "?" whose
 * popover gives the longer explanation and an example. `help` picks an entry by key; `false` hides it.
 */
export function Field({ label, error, hint, help: helpKey, children, className }: { label: ReactNode; error?: string; hint?: ReactNode; help?: string | false; children: ReactNode; className?: string }) {
  const found = useFieldHelp(label, typeof helpKey === 'string' ? helpKey : undefined);
  const help = helpKey === false ? null : found;
  return (
    <label className={cx('block space-y-1.5', className)}>
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? <span className="block text-xs text-danger">{error}</span> : <HelpLine title={label} help={help} hint={hint} />}
    </label>
  );
}

/** Money input: the user types major units, the value handed to the form is integer minor units. */
export function MoneyInput({ value, onChange, ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | null | undefined; onChange: (minor: number | null) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value / 100));
  useEffect(() => {
    const parsed = Number(text.replace(/\s/g, '').replace(',', '.'));
    if (value !== (text === '' || Number.isNaN(parsed) ? null : Math.round(parsed * 100))) setText(value === null || value === undefined ? '' : String(value / 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Input
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(/\s/g, '').replace(',', '.'));
        onChange(e.target.value === '' || Number.isNaN(n) ? null : Math.round(n * 100));
      }}
      {...p}
    />
  );
}

/* ----------------------------------------------------------------------------- cards */

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    // min-w-0: inside a grid a card must shrink to the column and let wide tables / code scroll inside it
    <section className={cx('min-w-0 rounded-xl border border-border bg-surface shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 pb-1 pt-3.5">
          <h2 className="min-w-0 text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="min-w-0 p-4">{children}</div>
    </section>
  );
}

const BADGE = {
  neutral: ['bg-surface-2 text-muted', 'bg-muted'],
  success: ['bg-success/12 text-success', 'bg-success'],
  danger: ['bg-danger/12 text-danger', 'bg-danger'],
  warn: ['bg-warn/14 text-warn', 'bg-warn'],
  info: ['bg-primary/12 text-primary', 'bg-primary'],
} as const;
export function Badge({ tone = 'neutral', children, dot }: { tone?: keyof typeof BADGE; children: ReactNode; dot?: boolean }) {
  const [box, dotCls] = BADGE[tone];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', box)}>
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', dotCls)} />}
      {children}
    </span>
  );
}

export function PageHeader({ title, actions, subtitle }: { title: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[1.35rem] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/** Counts from the previous value to the new one. Respects reduced motion. */
export function AnimatedNumber({ value, format, duration = 900 }: { value: number; format: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - k, 4);
      const cur = a + (value - a) * eased;
      setShown(Number.isInteger(value) ? Math.round(cur) : cur);
      from.current = cur;
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className="tabular">{format(shown)}</span>;
}

/** Revenue-style area line used inside the hero card. */
function Spark({ values }: { values: number[] }) {
  const id = useId().replace(/:/g, '');
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const w = 200;
  const h = 56;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - ((v - min) / (max - min || 1)) * (h - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-14 w-full" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".35" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${id})`} className="anim-fade" />
      <path d={line} fill="none" stroke="#fff" strokeOpacity=".95" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1, animation: 'kass-check 1.3s 0.2s cubic-bezier(.3,.7,.2,1) forwards' }} />
    </svg>
  );
}

export function Stat({ label, value, sub, tone, num, fmt, hero, spark, icon, delay = 0 }: {
  label: ReactNode; value?: ReactNode; sub?: ReactNode; tone?: 'success' | 'danger' | 'warn';
  /** Numeric value that counts up on load (with `fmt` to format it). */
  num?: number; fmt?: (n: number) => string;
  /** Large deep-teal card with a sparkline. */
  hero?: boolean; spark?: number[]; icon?: string; delay?: number;
}) {
  const pid = useId().replace(/:/g, '');
  const shown = num !== undefined ? <AnimatedNumber value={num} format={fmt ?? String} /> : value;
  const style = { '--d': `${delay}ms` } as CSSProperties;
  if (hero) {
    return (
      <div style={style} className="anim-rise relative isolate overflow-hidden rounded-xl bg-gradient-to-br from-[#0b6f7c] via-primary-deep to-[#052f38] p-5 text-white shadow-md">
        <div className="pointer-events-none absolute -right-10 -top-10 -z-10 h-56 w-56 text-white/[0.09]"><div className="star-spin h-full w-full"><StarPattern id={`h${pid}`} size={44} /></div></div>
        <div className="flex items-center gap-2 text-sm text-white/75">{icon && <Icon name={icon} className="h-4 w-4" />}{label}</div>
        <div className="tabular mt-2 font-display text-[1.7rem] font-semibold leading-tight tracking-tight sm:text-3xl">{shown}</div>
        {spark && <div className="-mx-1 mt-2"><Spark values={spark} /></div>}
        {sub && <div className="mt-2 text-xs text-white/75 [&_.text-danger]:text-[#ffb4b4] [&_.text-muted]:text-white/60 [&_.text-success]:text-[#9bf0c0]">{sub}</div>}
      </div>
    );
  }
  return (
    <div style={style} className="anim-rise rounded-xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted">{icon && <Icon name={icon} className="h-4 w-4" />}{label}</div>
      <div className={cx('tabular mt-1.5 text-[1.4rem] font-semibold leading-tight tracking-tight', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success', tone === 'warn' && 'text-warn')}>{shown}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted">
      <StarMark className="h-9 w-9 text-border" />
      {children ?? t('noData')}
    </div>
  );
}

/* ------------------------------------------------------------------------- modal */

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose is usually an inline arrow: keep it in a ref so a parent re-render neither re-binds
  // the key handler nor steals the focus from the field the user is typing in
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    const body = ref.current;
    (body?.querySelector<HTMLElement>('input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled])') ?? body?.querySelector<HTMLElement>('footer button, button'))?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="anim-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 backdrop-blur-[3px]" style={{ background: 'rgb(var(--scrim))' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx('anim-pop my-8 w-full rounded-2xl border border-border bg-surface shadow-lg', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 className="font-display text-base font-semibold">{title}</h2>
          <button aria-label="close" className="-mr-1.5 rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-fg" onClick={onClose}><Icon name="x" className="h-[18px] w-[18px]" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-3">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: ReactNode; message?: ReactNode; danger?: boolean; loading?: boolean }) {
  const t = useTranslations('common');
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{t('confirm')}</Button></>}>
      <p className="text-sm">{message}</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------------- table */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

export function DataTable<T extends Record<string, any>>({ columns, rows, loading, onRowClick, rowKey, footer }: { columns: Column<T>[]; rows: T[] | undefined; loading?: boolean; onRowClick?: (r: T) => void; rowKey?: (r: T, i: number) => string; footer?: ReactNode }) {
  const cell = (c: Column<T>, r: T, i: number) => (c.render ? c.render(r, i) : (r[c.key] as ReactNode));
  const keyOf = (r: T, i: number) => (rowKey ? rowKey(r, i) : (r.id ?? i));
  // phones: one card per row (first column as the title, the rest as label: value, actions at the bottom)
  const [titleCol, ...rest] = columns;
  const labelled = rest.filter((c) => c.header !== '' && c.header !== null && c.header !== undefined);
  const actions = rest.filter((c) => c.header === '' || c.header === null || c.header === undefined);
  return (
    <>
      <div className="space-y-2 sm:hidden">
        {loading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        {!loading && rows?.length === 0 && <div className="rounded-xl border border-border bg-surface"><Empty /></div>}
        {rows?.map((r, i) => (
          <div
            key={keyOf(r, i)}
            onClick={() => onRowClick?.(r)}
            className={cx('rounded-xl border border-border bg-surface p-3.5 text-sm shadow-sm transition-colors', onRowClick && 'cursor-pointer active:bg-primary/[0.06]')}
          >
            {titleCol && <div className="min-w-0 break-words font-medium">{cell(titleCol, r, i)}</div>}
            {labelled.length > 0 && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                {labelled.map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-xs leading-5 text-muted">{c.header}</dt>
                    <dd className="tabular min-w-0 break-words text-right">{cell(c, r, i)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions.length > 0 && <div className="mt-2 flex flex-wrap justify-end gap-1" onClick={(e) => e.stopPropagation()}>{actions.map((c) => <div key={c.key}>{cell(c, r, i)}</div>)}</div>}
          </div>
        ))}
        {footer && (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface-2/70 text-sm font-medium">
            <table className="w-full"><tfoot>{footer}</tfoot></table>
          </div>
        )}
      </div>
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface shadow-sm sm:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-surface-2/70 text-xs text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={cx('px-3.5 py-2.5 font-medium', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left', c.className)}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && [0, 1, 2].map((i) => <tr key={i} className="border-t border-border"><td colSpan={columns.length} className="px-3.5 py-3"><Skeleton className="h-5 w-full" /></td></tr>)}
            {!loading && rows?.length === 0 && <tr><td colSpan={columns.length}><Empty /></td></tr>}
            {rows?.map((r, i) => (
              <tr key={keyOf(r, i)} className={cx('border-t border-border transition-colors', onRowClick ? 'cursor-pointer hover:bg-primary/[0.06]' : 'hover:bg-surface-2/50')} onClick={() => onRowClick?.(r)}>
                {columns.map((c) => (
                  <td key={c.key} className={cx('px-3.5 py-2.5 align-middle', c.align === 'right' ? 'tabular text-right' : c.align === 'center' ? 'text-center' : '', c.className)}>
                    {cell(c, r, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot className="border-t border-border bg-surface-2/70 font-medium">{footer}</tfoot>}
        </table>
      </div>
    </>
  );
}

export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const t = useTranslations('common');
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted">
      <span className="tabular">{total}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t('back')}</Button>
        <span className="tabular">{t('page')} {page} / {pages}</span>
        <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t('next')}</Button>
      </div>
    </div>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: Array<{ key: K; label: ReactNode }>; value: K; onChange: (k: K) => void }) {
  return (
    <div className="mb-4 max-w-full overflow-x-auto">
      <div className="inline-flex gap-1 rounded-xl bg-surface-2 p-1" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className={cx('whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm transition', value === t.key ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg')}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- toasts */

type Toast = { id: number; text: string; tone: 'success' | 'error' };
const ToastCtx = createContext<{ push: (text: string, tone?: Toast['tone']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l, { id, text, tone }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className="anim-toast pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm shadow-lg">
            <span className={cx('mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full', i.tone === 'error' ? 'bg-danger/15 text-danger' : 'bg-success/15 text-success')}>
              <Icon name={i.tone === 'error' ? 'x' : 'check'} className="h-3 w-3" strokeWidth={2.6} />
            </span>
            <span className="min-w-0 flex-1 break-words">{i.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return {
    ok: (t: string) => c.push(t, 'success'),
    error: (e: unknown) => c.push(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e), 'error'),
  };
}

/** Shows an API error message inside a form. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const details = Array.isArray(e.details) ? e.details.map((d: any) => `${d.path}: ${d.message}`).join('; ') : '';
  return <p role="alert" className="anim-pop rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{e.message}{details && <span className="block text-xs">{details}</span>}</p>;
}
