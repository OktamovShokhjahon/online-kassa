'use client';

import { useLocale, useMessages, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { HELP, LANG_INDEX, type HelpEntry } from '@/lib/help';

/* --------------------------------------------------------------------- lookup */

/** label text -> i18n keys that have this text, per locale (built once). */
const indexCache = new Map<string, Map<string, string[]>>();

function buildIndex(messages: Record<string, unknown>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'string') {
      const k = normalize(o);
      const list = idx.get(k);
      if (list) list.push(path);
      else idx.set(k, [path]);
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(messages, '');
  return idx;
}

/** "Price (UZS)" / "Name:" / "Name *" -> "price"/"name": labels often carry a suffix. */
function normalize(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s:*]+$/, '').trim().toLowerCase();
}

function textOf(node: ReactNode): string | null {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(textOf);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return null;
}

/** Page part of the URL: `/shop/products` -> `products`, `/superadmin/shops/1` -> `sa-shops`, `/pos` -> `pos`. */
function sectionOf(pathname: string): string {
  const segs = pathname.split('/').filter((s) => s && !/^[a-f\d]{24}$/i.test(s) && s !== 'new');
  if (segs[0] === 'superadmin') return `sa-${segs[1] ?? 'dashboard'}`;
  if (segs[0] === 'shop') return segs[1] ?? 'dashboard';
  return segs[0] ?? '';
}

/** i18n namespaces that belong to a page whose URL has another name. */
const SECTION_NS: Record<string, string> = { promotions: 'promos', writeoffs: 'docs', receipts: 'receipts', 'sa-shops': 'shop' };

function rank(key: string, section: string): number {
  const segs = key.split('.');
  const page = SECTION_NS[section] ?? section.replace(/^sa-/, '');
  const area = section.startsWith('sa-') ? 'sa' : section === 'pos' ? 'pos' : section === 'login' ? 'auth' : 'shop';
  if (segs[0] === area && segs.slice(1, -1).includes(page)) return 0;
  if (segs[0] === area) return 1;
  if (segs[0] === 'common') return 2;
  return 3;
}

export interface ResolvedHelp {
  short: string;
  more: string;
  example?: string;
}

/** Help for a field, found from its label text (or an explicit key). */
export function useFieldHelp(label: ReactNode, explicitKey?: string): ResolvedHelp | null {
  const locale = useLocale();
  const messages = useMessages() as Record<string, unknown>;
  const pathname = usePathname() ?? '';
  let index = indexCache.get(locale);
  if (!index) {
    index = buildIndex(messages);
    indexCache.set(locale, index);
  }
  const li = LANG_INDEX[locale] ?? 0;
  const section = sectionOf(pathname);
  let entry: HelpEntry | undefined;
  if (explicitKey) entry = HELP[`${section}:${explicitKey}`] ?? HELP[explicitKey];
  if (!entry) {
    const text = textOf(label);
    if (!text) return null;
    const keys = index.get(normalize(text)) ?? [];
    for (const k of keys) {
      entry = HELP[`${section}:${k}`];
      if (entry) break;
    }
    if (!entry) {
      // the same text can be a label on several pages ("Address"): prefer this page, then this area
      const best = keys.filter((k) => HELP[k]).sort((a, b) => rank(a, section) - rank(b, section))[0];
      if (best) entry = HELP[best];
    }
  }
  if (!entry) return null;
  const ex = entry.e === undefined ? undefined : typeof entry.e === 'string' ? entry.e : entry.e[li];
  return { short: entry.d[li], more: entry.m[li], example: ex };
}

/* ---------------------------------------------------------------------- popover */

const POP_W = 288;

/**
 * The "?" button. Hover, focus or tap opens a small card with the longer explanation and an
 * example; it is rendered in a portal so modals with scroll areas never clip it.
 */
export function HelpTip({ title, help }: { title?: ReactNode; help: ResolvedHelp }) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean; arrow: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number>();
  const id = useId();

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = card.current?.offsetHeight ?? 150;
    const vw = window.innerWidth;
    const above = r.bottom + 10 + h > window.innerHeight - 8 && r.top - 10 - h > 8;
    const left = Math.max(8, Math.min(vw - POP_W - 8, r.left + r.width / 2 - 28));
    setPos({ top: above ? r.top - 10 - h : r.bottom + 10, left, above, arrow: r.left + r.width / 2 - left });
  }, []);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const show = () => { window.clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { closeTimer.current = window.setTimeout(() => setOpen(false), 120); };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={t('help')}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold leading-none transition-colors ${open ? 'bg-primary text-white' : 'bg-primary/12 text-primary hover:bg-primary hover:text-white'}`}
      >
        ?
      </button>
      {open && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={card}
            id={id}
            role="tooltip"
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: POP_W }}
            className="anim-pop fixed z-[100] rounded-xl border border-border bg-surface p-3.5 text-left text-sm shadow-lg"
          >
            {pos && (
              <span
                aria-hidden
                style={{ left: Math.max(12, Math.min(POP_W - 20, pos.arrow - 5)) }}
                className={`absolute h-2.5 w-2.5 rotate-45 border-border bg-surface ${pos.above ? '-bottom-[6px] border-b border-r' : '-top-[6px] border-l border-t'}`}
              />
            )}
            {title && <p className="mb-1 font-semibold text-fg">{title}</p>}
            <p className="leading-relaxed text-muted">{help.more}</p>
            {help.example && (
              <div className="mt-2.5 flex items-start gap-2 border-t border-border pt-2.5">
                <span className="mt-0.5 shrink-0 text-xs text-muted">{t('example')}</span>
                <code className="min-w-0 break-all rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary">{help.example}</code>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The line under an input: "?" + short definition (or the page's own hint). */
export function HelpLine({ title, help, hint }: { title?: ReactNode; help: ResolvedHelp | null; hint?: ReactNode }) {
  if (!help && !hint) return null;
  return (
    <span className="flex items-start gap-1.5 text-xs text-muted">
      {help && <span className="mt-px"><HelpTip title={title} help={help} /></span>}
      <span className="min-w-0">{hint ?? help?.short}</span>
    </span>
  );
}
