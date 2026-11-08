import { z } from 'zod';
import { CURRENCIES, LANGUAGES } from '../constants';
import { normalizePhone } from '../phone';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const languageSchema = z.enum(LANGUAGES);
export const currencySchema = z.enum(CURRENCIES);

export const phoneSchema = z
  .string()
  .transform((v, ctx) => {
    const n = normalizePhone(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
      return z.NEVER;
    }
    return n;
  });

export const loginSchema = z
  .string()
  .regex(/^[A-Za-z0-9._]{4,32}$/, 'Login: 4-32 characters, Latin letters, digits, dot, underscore');

export const passwordSchema = z.string().min(8, 'Password must have at least 8 characters').max(128);

/** Integer count of minor units (tiyin / cents / kopeks); never a float. */
export const moneySchema = z.number().int().min(0);
export const signedMoneySchema = z.number().int();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().regex(/^-?[A-Za-z0-9_.]+$/).optional(),
  q: z.string().trim().max(100).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const isoDate = z.coerce.date();
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
