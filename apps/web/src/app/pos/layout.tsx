'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { PosProvider } from '@/lib/pos/store';

const ROLES = ['cashier', 'shop_admin', 'branch_manager'];

export default function PosLayout({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anon') router.replace('/login');
    if (status === 'authed' && user && !ROLES.includes(user.role)) router.replace('/');
  }, [status, user, router]);
  if (status !== 'authed' || !user || !ROLES.includes(user.role)) return <div className="flex h-screen items-center justify-center"><Spinner /></div>;
  return <PosProvider>{children}</PosProvider>;
}
