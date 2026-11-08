'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { Spinner } from '@/components/ui';

const HOME = { superadmin: '/superadmin', cashier: '/pos' } as Record<string, string>;

export default function Index() {
  const { status, user } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anon') router.replace('/login');
    if (status === 'authed' && user) router.replace(HOME[user.role] ?? '/shop');
  }, [status, user, router]);
  return <div className="flex h-screen items-center justify-center"><Spinner /></div>;
}
