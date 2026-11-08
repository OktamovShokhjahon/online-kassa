'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/icons';

export type Theme = 'light' | 'dark';
const KEY = 'kass.theme';

/**
 * Runs in <head> before the first paint so there is no flash of the wrong theme.
 * A stored choice wins; otherwise the operating system preference decides.
 */
export const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('${KEY}');var t=s==='light'||s==='dark'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){}})();`;

const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme, origin?: { x: number; y: number }) => void; toggle: (e?: MouseEvent) => void } | null>(null);

function read(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  useEffect(() => setThemeState(read()), []);

  // follow the system while the user has not chosen
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(KEY); } catch { /* private mode */ }
      if (stored === 'light' || stored === 'dark') return;
      const t: Theme = mq.matches ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      setThemeState(t);
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const apply = useCallback((t: Theme) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
    setThemeState(t);
  }, []);

  const setTheme = useCallback((t: Theme, origin?: { x: number; y: number }) => {
    const doc = document as any;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduce || !origin) { apply(t); return; }
    // the new theme grows as a circle from the button that was pressed
    const radius = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y));
    const vt = doc.startViewTransition(() => flushSync(() => apply(t)));
    vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
        { duration: 650, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => undefined);
  }, [apply]);

  const toggle = useCallback((e?: MouseEvent) => {
    const next: Theme = read() === 'dark' ? 'light' : 'dark';
    const r = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    setTheme(next, r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
  }, [setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c;
}

/** Sun/moon button. The icons swap through CSS so the first paint already matches the stored theme. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { toggle } = useTheme();
  const t = useTranslations('common');
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t('theme')}
      title={t('theme')}
      className={`relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-border bg-surface text-fg shadow-sm transition hover:bg-surface-2 active:scale-95 ${className}`}
    >
      <Icon name="sun" className="absolute h-[18px] w-[18px] rotate-0 scale-100 text-accent transition duration-500 dark:-rotate-90 dark:scale-0" />
      <Icon name="moon" className="absolute h-[18px] w-[18px] rotate-90 scale-0 text-primary transition duration-500 dark:rotate-0 dark:scale-100" />
    </button>
  );
}
