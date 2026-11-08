import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LANGUAGE, isLanguage, messages } from '@kass/shared';

/** The interface language is a per-user choice kept in a cookie (no locale in the URL). */
export default getRequestConfig(async () => {
  const c = cookies().get('NEXT_LOCALE')?.value;
  const locale = isLanguage(c) ? c : DEFAULT_LANGUAGE;
  return { locale, messages: messages[locale] as any, timeZone: 'Asia/Tashkent' };
});
