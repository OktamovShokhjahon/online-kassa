import type { Request } from 'express';
import type { Types } from 'mongoose';
import { formatTashkent, tashkentDateString, tashkentPeriod, translate, type Currency, type Language } from '@kass/shared';
import { oid } from '../../lib/util';
import { forbidden } from '../../lib/errors';
import { canAccessBranch } from '../../middleware/auth';
import type { AuthContext } from '../../types';

export type ColType = 'text' | 'money' | 'number' | 'percent' | 'date' | 'datetime';
export interface Col {
  key: string;
  /** Translation key under `reports.col.*` */
  label: string;
  type: ColType;
}
export interface ReportResult {
  columns: Col[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, number>;
  /** Total rows when the report paginates in the database. */
  total?: number;
  note?: string;
}

export interface ReportCtx {
  a: AuthContext;
  shopId: Types.ObjectId;
  currency: Currency;
  lang: Language;
  from: Date;
  to: Date;
  fromStr: string;
  toStr: string;
  /** Branches the caller may see, narrowed by `branchId` if given. null = every branch of the shop (admin). */
  branchIds: Types.ObjectId[] | null;
  page: number;
  limit: number;
  params: Record<string, any>;
}

export type Access = 'admin' | 'manager' | 'stock';

export interface ReportDef {
  key: string;
  titleKey: string;
  access: Access;
  run: (ctx: ReportCtx) => Promise<ReportResult>;
}

export const col = (key: string, type: ColType = 'text'): Col => ({ key, label: key, type });

/** Mongo condition limiting `field` to the report's branches. */
export function branchMatch(ctx: ReportCtx, field = 'branchId'): Record<string, unknown> {
  return ctx.branchIds ? { [field]: { $in: ctx.branchIds } } : {};
}

/** Tashkent calendar day of a date field (UTC+5, no DST). */
export const dayOf = (field = '$createdAt') => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: '+05:00' } });

export function canSee(req: Request, access: Access): boolean {
  const a = req.auth!;
  if (a.role === 'shop_admin') return true;
  if (access === 'admin') return false;
  if (access === 'manager') return a.permissions.has('reports.view');
  return a.permissions.has('reports.view') || a.permissions.has('reports.stock');
}

export function buildCtx(req: Request, q: Record<string, any>): ReportCtx {
  const a = req.auth!;
  const today = tashkentDateString(new Date());
  const thirtyAgo = tashkentDateString(new Date(Date.now() - 29 * 86_400_000));
  const fromStr = q.from ?? thirtyAgo;
  const toStr = q.to ?? today;
  const { from, to } = tashkentPeriod(fromStr, toStr);

  let branchIds: Types.ObjectId[] | null = null;
  if (q.branchId) {
    if (!canAccessBranch(a, q.branchId)) throw forbidden();
    branchIds = [oid(q.branchId)];
  } else if (a.role !== 'shop_admin') {
    branchIds = a.branchIds;
  }
  return {
    a,
    shopId: a.shopId!,
    currency: a.shop!.currency as Currency,
    lang: (a.user.language as Language) ?? 'uz',
    from,
    to,
    fromStr,
    toStr,
    branchIds,
    page: Math.max(1, Number(q.page ?? 1)),
    limit: Math.min(1000, Math.max(1, Number(q.limit ?? 100))),
    params: q,
  };
}

/* ------------------------------------------------------------------------ exports */

export const label = (lang: Language, c: Col) => translate(lang, `reports.col.${c.label}`);
export const title = (lang: Language, def: ReportDef) => translate(lang, `reports.title.${def.titleKey}`);

/** Plain value for spreadsheets/PDF: money in major units, dates in Tashkent time. */
export function exportValue(c: Col, v: unknown): string | number {
  if (v === null || v === undefined || v === '') return '';
  switch (c.type) {
    case 'money':
      return Number(v) / 100;
    case 'number':
    case 'percent':
      return Number(v);
    case 'date':
      return typeof v === 'string' ? v : tashkentDateString(new Date(v as any));
    case 'datetime':
      return formatTashkent(v as any);
    default:
      return String(v);
  }
}
