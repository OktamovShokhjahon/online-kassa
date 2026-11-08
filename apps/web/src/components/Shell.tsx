'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LANGUAGES, type Language } from '@kass/shared';
import { refreshSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ThemeToggle } from '@/lib/theme';
import { Icon, LogoMark } from './icons';
import { Button, Spinner } from './ui';

export interface NavItem {
  href: string;
  label: string;
  /** Visible if the user holds ANY of these permission codes (admin sees everything). */
  perms?: string[];
  group?: string;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

/** Common frame of the superadmin and shop panels: sidebar, language switcher, theme toggle, banners. */
export function Shell({ nav, children, roles, ns }: { nav: NavItem[]; children: ReactNode; roles: string[]; ns: string }) {
  const t = useTranslations(ns);
  const tc = useTranslations('common');
  const tr = useTranslations('roles');
  const ta = useTranslations('auth');
  const locale = useLocale() as Language;
  const path = usePathname();
  const router = useRouter();
  const { status, user, shop, impersonating, logout, setLanguage, can, applySession } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
    if (status === 'authed' && user && !roles.includes(user.role)) router.replace('/');
  }, [status, user, roles, router]);
  useEffect(() => setOpen(false), [path]);

  if (status !== 'authed' || !user) return <div className="flex h-screen items-center justify-center"><Spinner /></div>;

  const items = nav.filter((n) => !n.perms || n.perms.some((p) => can(p)));

  async function exitImpersonation() {
    const p = await refreshSession(); // the superadmin's own refresh cookie is untouched
    if (p) {
      document.cookie = 'kass_role=superadmin; path=/; max-age=31536000; samesite=lax';
      applySession(p, { impersonating: false });
      router.push('/superadmin');
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-surface/90 backdrop-blur-xl transition-transform duration-300 md:sticky md:top-0 md:h-screen md:translate-x-0 ${open ? 'translate-x-0 shadow-lg' : '-translate-x-full'}`}>
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <LogoMark size={38} />
          <div className="min-w-0">
            <div className="font-display text-[0.95rem] font-semibold leading-tight">Online Kass</div>
            <div className="truncate text-xs text-muted">{shop?.name ?? t('platform')}</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4" aria-label="main">
          {items.map((n, i) => {
            const active = path === n.href || (n.href !== '/shop' && n.href !== '/superadmin' && path.startsWith(n.href));
            return (
              <div key={n.href}>
                {n.group && n.group !== items[i - 1]?.group && <div className="mt-4 px-3 pb-1.5 text-xs font-medium text-muted/80">{t(`group.${n.group}`)}</div>}
                <Link
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${active ? 'bg-primary/10 font-medium text-primary' : 'text-fg/80 hover:bg-surface-2 hover:text-fg'}`}
                >
                  {active && <span className="anim-bar absolute inset-y-1.5 -left-3 w-[3px] rounded-r-full bg-primary" />}
                  <Icon name={n.label} className={`h-[18px] w-[18px] shrink-0 transition-transform duration-200 ${active ? '' : 'text-muted group-hover:translate-x-0.5 group-hover:text-fg'}`} />
                  <span className="truncate">{t(`nav.${n.label}`)}</span>
                </Link>
              </div>
            );
          })}
        </nav>
      </aside>
      {open && <div className="anim-fade fixed inset-0 z-30 backdrop-blur-[2px] md:hidden" style={{ background: 'rgb(var(--scrim))' }} onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {impersonating && (
          <div className="flex items-center justify-between gap-2 bg-accent px-4 py-2 text-sm font-medium text-[#241600]" role="alert">
            <span>{t('impersonating', { shop: shop?.name ?? '' })}</span>
            <Button size="sm" variant="secondary" onClick={exitImpersonation}>{t('exitImpersonation')}</Button>
          </div>
        )}
        {shop?.inGrace && <div className="bg-warn/15 px-4 py-2 text-sm text-warn" role="alert">{ta('graceWarning', { days: shop.graceDaysLeft ?? 0 })}</div>}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b border-border/80 bg-surface/75 px-4 py-2.5 backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <button className="rounded-lg p-2 text-fg transition hover:bg-surface-2 md:hidden" aria-label="menu" onClick={() => setOpen(true)}><Icon name="menu" className="h-5 w-5" /></button>
            <div className="hidden text-sm text-muted md:block">{tr(user.role)}</div>
          </div>
          <div className="flex items-center gap-2.5">
            <div role="group" aria-label={tc('language')} className="flex rounded-full border border-border bg-surface-2/70 p-0.5 text-xs">
              {LANGUAGES.map((l) => (
                <button key={l} aria-pressed={locale === l} onClick={() => setLanguage(l)} className={`rounded-full px-2.5 py-1 font-medium transition ${locale === l ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{l.toUpperCase()}</button>
              ))}
            </div>
            <ThemeToggle />
            <div className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 shadow-sm">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-deep text-xs font-semibold text-primary-fg">{initials(user.fullName)}</span>
              <span className="hidden max-w-[10rem] truncate text-sm sm:inline">{user.fullName}</span>
            </div>
            <button onClick={() => logout()} aria-label={tc('logout')} title={tc('logout')} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-danger"><Icon name="logout" className="h-[18px] w-[18px]" /></button>
          </div>
        </header>
        <main key={path} className="anim-fade mx-auto w-full min-w-0 max-w-[1680px] flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
