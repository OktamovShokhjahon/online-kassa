'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Currency, Language, Permission, Role } from '@kass/shared';
import { api, post, refreshSession, setAccessToken, setApiLanguage, setAuthLostHandler } from './api';

export interface SessionUser {
  id: string;
  role: Role;
  shopId: string | null;
  fullName: string;
  login: string;
  branchIds: string[];
  permissions: Permission[];
  language: Language;
  hasPin: boolean;
}
export interface SessionShop {
  id: string;
  name: string;
  currency: Currency;
  currencyLocked: boolean;
  fiscalEnabled: boolean;
  logoUrl?: string;
  status: 'trial' | 'active' | 'expired' | 'blocked';
  inGrace: boolean;
  graceDaysLeft: number | null;
  paidUntil: string | null;
  settings: { allowNegativeStock: boolean; maxCashierDiscount: number; receiptLanguage: Language; receiptHeader: string; receiptFooter: string; loyalty: { bonusPercent: number; maxPayPercent: number }; openShiftAlertHours: number };
}

interface AuthState {
  status: 'loading' | 'authed' | 'anon';
  user: SessionUser | null;
  shop: SessionShop | null;
  impersonating: boolean;
  can: (perm: string) => boolean;
  login: (login: string, password: string, language?: Language) => Promise<string>;
  logout: () => Promise<void>;
  applySession: (payload: any, opts?: { impersonating?: boolean }) => void;
  reload: () => Promise<void>;
  setLanguage: (l: Language) => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
};

function setCookie(name: string, value: string, days = 365) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${days * 86400}; samesite=lax`;
}

export function AuthProvider({ children, initialLanguage }: { children: ReactNode; initialLanguage: Language }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [shop, setShop] = useState<SessionShop | null>(null);
  const [impersonating, setImpersonating] = useState(false);

  const applySession = useCallback((p: any, opts?: { impersonating?: boolean }) => {
    setUser(p.user);
    setShop(p.shop ?? null);
    setImpersonating(!!(opts?.impersonating ?? p.impersonatedBy));
    setStatus('authed');
    if (p.accessToken) setAccessToken(p.accessToken);
    if (p.user?.language) {
      setApiLanguage(p.user.language);
      setCookie('NEXT_LOCALE', p.user.language);
    }
  }, []);

  const lost = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    setShop(null);
    setStatus('anon');
    router.replace('/login');
  }, [router]);

  useEffect(() => {
    setApiLanguage(initialLanguage);
    setAuthLostHandler(lost);
    refreshSession()
      .then((p) => (p ? applySession(p) : setStatus('anon')))
      .catch(() => setStatus('anon'));
    return () => {
      setAuthLostHandler(null);
    };
  }, [applySession, lost, initialLanguage]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      shop,
      impersonating,
      can: (perm) => !!user && (user.role === 'shop_admin' || user.permissions.includes(perm as Permission)),
      login: async (login, password, language) => {
        const d = await post('/auth/login', { login, password, language });
        applySession(d);
        return d.home as string;
      },
      logout: async () => {
        await post('/auth/logout').catch(() => undefined);
        document.cookie = 'kass_role=; path=/; max-age=0';
        lost();
      },
      applySession,
      reload: async () => {
        const d = await api('/auth/me');
        applySession(d, { impersonating: !!d.impersonatedBy });
      },
      setLanguage: async (l) => {
        setCookie('NEXT_LOCALE', l);
        setApiLanguage(l);
        await api('/auth/language', { method: 'PATCH', json: { language: l } }).catch(() => undefined);
        setUser((u) => (u ? { ...u, language: l } : u));
        router.refresh();
      },
    }),
    [status, user, shop, impersonating, applySession, lost, router],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
