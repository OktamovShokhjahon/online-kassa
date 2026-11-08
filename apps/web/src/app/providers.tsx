'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Language } from '@kass/shared';
import { AuthProvider } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { ToastProvider } from '@/components/ui';

export function Providers({ children, language }: { children: ReactNode; language: Language }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true /* sales and products also arrive from the tills and other devices */ } } }));
  return (
    <ThemeProvider>
    <QueryClientProvider client={client}>
      <AuthProvider initialLanguage={language}>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
    </ThemeProvider>
  );
}
