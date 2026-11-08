import { toTashkent } from './time';

/**
 * Promotion engine (spec 6.4). Pure functions shared by the API (authoritative) and the POS
 * (live preview and offline mode), so both always compute the same discounts.
 */
export const PROMOTION_TYPES = ['percent', 'fixed', 'buy_x_get_y', 'bundle'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export interface PromotionDef {
  id: string;
  name: string;
  type: PromotionType;
  /** Higher wins ties and is evaluated first. */
  priority: number;
  /** When true a manual discount may be added on top of this promotion. */
  allowStack: boolean;
  isActive: boolean;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  /** Empty = all branches. */
  branchIds: string[];
  /** Time-based discount: days of week (0=Sunday..6) and a daily window in Tashkent time. */
  schedule?: { days?: number[]; from?: string; to?: string } | null;
  rules: {
    percent?: number;
    /** fixed discount per unit, minor units */
    amount?: number;
    productIds?: string[];
    categoryIds?: string[];
    buyQty?: number;
    getQty?: number;
    items?: Array<{ productId: string; qty: number }>;
    bundlePrice?: number;
  };
}

export interface CartLine {
  key: string;
  productId: string;
  /** Product category and all its ancestors. */
  categoryIds: string[];
  qty: number;
  /** Unit price, minor units. */
  price: number;
}

export interface AppliedPromotion {
  key: string;
  promotionId: string;
  name: string;
  /** Total discount for the line, minor units. */
  discount: number;
  allowStack: boolean;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function isPromotionActive(p: PromotionDef, branchId: string, now: Date): boolean {
  if (!p.isActive) return false;
  if (p.startsAt && now < new Date(p.startsAt)) return false;
  if (p.endsAt && now > new Date(p.endsAt)) return false;
  if (p.branchIds.length && !p.branchIds.includes(branchId)) return false;
  if (p.schedule) {
    const t = toTashkent(now);
    if (p.schedule.days?.length && !p.schedule.days.includes(t.getUTCDay())) return false;
    if (p.schedule.from && p.schedule.to) {
      const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
      const from = toMinutes(p.schedule.from);
      const to = toMinutes(p.schedule.to);
      const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to; // overnight window
      if (!inside) return false;
    }
  }
  return true;
}

const matchesTarget = (p: PromotionDef, line: CartLine) => {
  const { productIds, categoryIds } = p.rules;
  const hasP = !!productIds?.length;
  const hasC = !!categoryIds?.length;
  if (!hasP && !hasC) return true; // whole assortment
  return (hasP && productIds!.includes(line.productId)) || (hasC && line.categoryIds.some((c) => categoryIds!.includes(c)));
};

function lineDiscount(p: PromotionDef, line: CartLine): number {
  const gross = Math.round(line.qty * line.price);
  let d = 0;
  if (p.type === 'percent') d = Math.round((gross * (p.rules.percent ?? 0)) / 100);
  else if (p.type === 'fixed') d = Math.round(line.qty * (p.rules.amount ?? 0));
  else if (p.type === 'buy_x_get_y') {
    const buy = p.rules.buyQty ?? 0;
    const get = p.rules.getQty ?? 0;
    if (buy > 0 && get > 0) d = Math.floor(line.qty / (buy + get)) * get * line.price;
  }
  return Math.max(0, Math.min(d, gross));
}

/**
 * Applies the best eligible promotion to every cart line (at most one per line).
 * Bundles are resolved first (by priority), then single-line promotions.
 */
export function applyPromotions(lines: CartLine[], promotions: PromotionDef[], branchId: string, now = new Date()): AppliedPromotion[] {
  const active = promotions
    .filter((p) => isPromotionActive(p, branchId, now))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const result = new Map<string, AppliedPromotion>();

  // 1) bundles: "set price" when all items are in the cart
  for (const p of active.filter((x) => x.type === 'bundle')) {
    const items = p.rules.items ?? [];
    const price = p.rules.bundlePrice;
    if (!items.length || price === undefined) continue;
    const free = (productId: string) => lines.filter((l) => l.productId === productId && !result.has(l.key));
    const sets = Math.min(...items.map((it) => Math.floor(free(it.productId).reduce((s, l) => s + l.qty, 0) / it.qty)));
    if (!Number.isFinite(sets) || sets < 1) continue;
    const regular = items.reduce((s, it) => s + it.qty * (free(it.productId)[0]?.price ?? 0), 0);
    const perSet = regular - price;
    if (perSet <= 0) continue;
    const total = perSet * sets;
    let allocated = 0;
    const touched: Array<{ line: CartLine; weight: number }> = [];
    for (const it of items) {
      let need = it.qty * sets;
      for (const l of free(it.productId)) {
        if (need <= 0) break;
        const take = Math.min(l.qty, need);
        need -= take;
        touched.push({ line: l, weight: take * l.price });
      }
    }
    const weightSum = touched.reduce((s, t) => s + t.weight, 0);
    touched.forEach((t, i) => {
      const share = i === touched.length - 1 ? total - allocated : Math.round((total * t.weight) / weightSum);
      allocated += share;
      const prev = result.get(t.line.key);
      result.set(t.line.key, { key: t.line.key, promotionId: p.id, name: p.name, discount: (prev?.discount ?? 0) + share, allowStack: p.allowStack });
    });
  }

  // 2) single-line promotions: the largest discount wins, priority breaks ties
  for (const line of lines) {
    if (result.has(line.key)) continue;
    let best: AppliedPromotion | null = null;
    for (const p of active) {
      if (p.type === 'bundle' || !matchesTarget(p, line)) continue;
      const discount = lineDiscount(p, line);
      if (discount > (best?.discount ?? 0)) best = { key: line.key, promotionId: p.id, name: p.name, discount, allowStack: p.allowStack };
    }
    if (best) result.set(line.key, best);
  }
  return lines.map((l) => result.get(l.key)).filter((x): x is AppliedPromotion => !!x);
}
