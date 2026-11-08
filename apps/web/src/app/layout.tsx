import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import '@fontsource-variable/onest';
import '@fontsource-variable/unbounded';
import type { Language } from '@kass/shared';
import { THEME_SCRIPT } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = { title: 'Online Kass', description: 'Cash desk and inventory platform' };
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f0f4f3' }, { media: '(prefers-color-scheme: dark)', color: '#071114' }],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as Language;
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Tashkent">
          <Providers language={locale}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
