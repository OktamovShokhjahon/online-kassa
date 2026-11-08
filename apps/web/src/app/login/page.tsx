'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties, type FormEvent } from 'react';
import { LANGUAGES, type Language } from '@kass/shared';
import { Icon, LogoMark, StarPattern } from '@/components/icons';
import { Button, Field, FormError, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { ThemeToggle } from '@/lib/theme';

const d = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;

/** Concentric turning squares: the one memorable shape of the product. */
function Medallion() {
  return (
    <div className="relative mx-auto aspect-square w-[min(20rem,28vh)]" aria-hidden="true">
      <div className="absolute inset-0 rounded-full bg-accent/20 blur-3xl" />
      {[
        { s: '70%', r: 0, o: 0.95, spin: true },
        { s: '70%', r: 45, o: 0.95, spin: true },
        { s: '52%', r: 22.5, o: 0.5, spin: false },
        { s: '52%', r: 67.5, o: 0.5, spin: false },
        { s: '34%', r: 0, o: 0.35, spin: false },
        { s: '34%', r: 45, o: 0.35, spin: false },
      ].map((q, i) => (
        <div key={i} className="absolute left-1/2 top-1/2" style={{ width: q.s, height: q.s, transform: 'translate(-50%, -50%)' }}>
          <div className={q.spin ? 'star-spin h-full w-full' : 'h-full w-full'} style={{ animationDuration: q.spin ? '300s' : undefined, transform: q.spin ? undefined : `rotate(${q.r}deg)` }}>
            <div className="h-full w-full rounded-[6%] border" style={{ transform: q.spin ? `rotate(${q.r}deg)` : undefined, borderColor: i < 2 ? 'rgb(var(--accent) / .85)' : 'rgb(255 255 255 / .35)', opacity: q.o, borderWidth: i < 2 ? 2 : 1 }} />
          </div>
        </div>
      ))}
      <div className="absolute left-1/2 top-1/2 h-[18%] w-[18%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[22%] bg-accent shadow-[0_0_60px_rgb(var(--accent)/0.7)]" />
    </div>
  );
}

export default function LoginPage() {
  const t = useTranslations('auth');
  const tl = useTranslations('languages');
  const locale = useLocale() as Language;
  const router = useRouter();
  const { login } = useAuth();
  const [form, setForm] = useState({ login: '', password: '' });
  const [lang, setLang] = useState<Language>(locale);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  function chooseLanguage(l: Language) {
    setLang(l);
    document.cookie = `NEXT_LOCALE=${l}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The shop is identified by the login itself; there is no shop selector (spec 3.1).
      const home = await login(form.login, form.password, lang);
      router.replace(home);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const features = [
    { icon: 'wifiOff', text: t('feat1') },
    { icon: 'printer', text: t('feat2') },
    { icon: 'reports', text: t('feat3') },
  ];

  return (
    <main className="grid min-h-screen lg:h-screen lg:grid-cols-[1.05fr_1fr] lg:overflow-hidden">
      {/* brand panel */}
      <section className="relative isolate hidden overflow-hidden bg-gradient-to-br from-[#0c7480] via-[#074652] to-[#031f26] text-white lg:flex lg:flex-col lg:justify-between lg:gap-6 lg:p-12">
        <div className="pointer-events-none absolute -inset-[40%] -z-10 text-white/[0.07]"><div className="star-spin h-full w-full" style={{ animationDuration: '480s' }}><StarPattern id="login-pattern" size={84} /></div></div>
        <div className="anim-rise flex items-center gap-3" style={d(0)}>
          <LogoMark size={42} className="!from-white/20 !to-white/5 !text-white ring-1 ring-white/25" />
          <span className="font-display text-lg font-semibold">Online Kass</span>
        </div>
        <div>
          <div className="anim-rise" style={d(120)}><Medallion /></div>
          <h2 className="anim-rise mt-6 max-w-lg font-display text-[2rem] font-semibold leading-[1.1] tracking-tight" style={d(240)}>{t('tagline')}</h2>
          <p className="anim-rise mt-4 max-w-md text-base leading-relaxed text-white/75" style={d(340)}>{t('taglineSub')}</p>
        </div>
        <ul className="space-y-3 text-sm text-white/85">
          {features.map((f, i) => (
            <li key={f.icon} className="anim-rise flex items-center gap-3" style={d(460 + i * 90)}>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15"><Icon name={f.icon} className="h-4 w-4" /></span>
              {f.text}
            </li>
          ))}
        </ul>
      </section>

      {/* form */}
      <section className="relative flex items-center justify-center overflow-y-auto p-5 pt-24 sm:p-10">
        <div className="absolute right-5 top-5 flex items-center gap-2 sm:right-8 sm:top-8">
          <div className="flex rounded-full border border-border bg-surface p-0.5 text-xs shadow-sm" role="group" aria-label="language">
            {LANGUAGES.map((l) => (
              <button key={l} type="button" onClick={() => chooseLanguage(l)} aria-pressed={lang === l} title={tl(l)} className={`rounded-full px-2.5 py-1 font-medium transition ${lang === l ? 'bg-primary text-primary-fg shadow-sm' : 'text-muted hover:text-fg'}`}>{l.toUpperCase()}</button>
            ))}
          </div>
          <ThemeToggle />
        </div>

        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="anim-rise flex items-center gap-3 lg:hidden" style={d(0)}>
            <LogoMark size={40} />
            <span className="font-display text-lg font-semibold">Online Kass</span>
          </div>
          <div className="anim-rise" style={d(60)}>
            <h1 className="font-display text-[1.75rem] font-semibold leading-tight">{t('title')}</h1>
          </div>
          <div className="anim-rise" style={d(140)}><Field label={t('login')}><Input autoFocus autoComplete="username" className="h-11" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} required /></Field></div>
          <div className="anim-rise" style={d(210)}><Field label={t('password')}><Input type="password" autoComplete="current-password" className="h-11" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></Field></div>
          <FormError error={error} />
          <div className="anim-rise" style={d(280)}><Button type="submit" size="lg" className="w-full" loading={busy}>{t('submit')}</Button></div>
        </form>
      </section>
    </main>
  );
}
