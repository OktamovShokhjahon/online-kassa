export const TIMEZONE = 'Asia/Tashkent';
export const TZ_OFFSET_HOURS = 5;

export const ROLES = ['superadmin', 'shop_admin', 'branch_manager', 'storekeeper', 'cashier'] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ['uz', 'ru', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'uz';

export const CURRENCIES = ['UZS', 'USD', 'RUB'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Stored status. Effective status (trial/expired) is derived from paidUntil. */
export const SHOP_STORED_STATUSES = ['active', 'blocked'] as const;
export type ShopStoredStatus = (typeof SHOP_STORED_STATUSES)[number];
export const SHOP_EFFECTIVE_STATUSES = ['trial', 'active', 'expired', 'blocked'] as const;
export type ShopEffectiveStatus = (typeof SHOP_EFFECTIVE_STATUSES)[number];

export const UNITS = ['piece', 'kg', 'gram', 'litre', 'metre', 'pack'] as const;
export type Unit = (typeof UNITS)[number];

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'other'] as const;
export const SALE_PAYMENT_METHODS = ['cash', 'card', 'bonus', 'credit'] as const;
export type SalePaymentMethod = (typeof SALE_PAYMENT_METHODS)[number];

/** Every permission code in the system. */
export const PERMISSIONS = [
  'settings.manage',
  'branches.manage',
  'terminals.manage',
  'staff.manage',
  'staff.cashiers',
  'categories.manage',
  'products.view',
  'products.manage',
  'prices.view',
  'suppliers.view',
  'suppliers.manage',
  'suppliers.pay',
  'stock.view',
  'stock.receipt',
  'stock.transfer',
  'stock.writeoff',
  'stock.count',
  'customers.view',
  'customers.manage',
  'customers.create',
  'promotions.manage',
  'shifts.operate',
  'sales.create',
  'sales.credit',
  'sales.discount',
  'sales.refund',
  'reports.view',
  'reports.stock',
  'reports.own_shift',
  'developers.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions that can never be delegated to a non-admin.
 * Selling prices are editable by the shop admin only (spec 2.2) - there is deliberately no
 * `prices.edit` permission; the API checks the role itself.
 */
export const ADMIN_ONLY_PERMISSIONS: Permission[] = [
  'settings.manage',
  'branches.manage',
  'terminals.manage',
  'staff.manage',
  'promotions.manage',
  'developers.manage',
  'audit.view',
];

const ALL_PERMISSIONS = [...PERMISSIONS] as Permission[];

/** Default permission set per role. Extra rights can be granted per employee. */
export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  superadmin: [],
  shop_admin: ALL_PERMISSIONS,
  branch_manager: [
    'staff.cashiers',
    'products.view',
    'prices.view',
    'suppliers.view',
    'stock.view',
    'stock.receipt',
    'stock.transfer',
    'stock.writeoff',
    'stock.count',
    'customers.view',
    'customers.manage',
    'customers.create',
    'sales.discount',
    'sales.refund',
    'sales.credit',
    'reports.view',
    'reports.stock',
  ],
  storekeeper: [
    'products.view',
    'suppliers.view',
    'stock.view',
    'stock.receipt',
    'stock.transfer',
    'stock.writeoff',
    'stock.count',
    'reports.stock',
  ],
  cashier: ['products.view', 'shifts.operate', 'sales.create', 'reports.own_shift', 'customers.view', 'customers.create'],
};

/** Permissions that may be added on top of the defaults, per role. */
export const ROLE_GRANTABLE_PERMISSIONS: Record<Role, Permission[]> = {
  superadmin: [],
  shop_admin: [],
  branch_manager: PERMISSIONS.filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p as Permission)) as Permission[],
  storekeeper: PERMISSIONS.filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p as Permission)) as Permission[],
  cashier: [
    'products.manage',
    'customers.create',
    'sales.credit',
    'sales.discount',
    'sales.refund',
  ],
};

export const SHOP_ROLES: Role[] = ['shop_admin', 'branch_manager', 'storekeeper', 'cashier'];
/** Roles that the shop admin may create as staff. */
export const STAFF_ROLES: Role[] = ['branch_manager', 'storekeeper', 'cashier'];

export const DEFAULT_PLATFORM_SETTINGS = {
  defaultLimits: { maxBranches: 3, maxTerminals: 5, maxEmployees: 20 },
  graceDays: 3,
  platformName: 'Online Kass',
  logoUrl: '',
  agentInstaller: { url: '', version: '1.0.0' },
  longShiftHours: 24,
};

export const API_PREFIX = '/api/v1';

/**
 * Warehouse (stock) features: the "Ombor" menu, stock reports, stock alerts and the stock checks of
 * a sale. Turned off for now: products are sold without counting quantities and profit comes from
 * each product's cost price. Movements are still recorded in the background, so switching it back
 * on later (KASS_INVENTORY=true for the API, NEXT_PUBLIC_INVENTORY=true for the web app) needs no
 * migration.
 */
export function inventoryEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  return process.env.KASS_INVENTORY === 'true' || process.env.NEXT_PUBLIC_INVENTORY === 'true';
}

/** Reports that only make sense with the warehouse. */
export const INVENTORY_REPORTS = ['stock', 'stock-movement', 'negative-stock', 'slow-moving'] as const;
