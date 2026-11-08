import { inventoryEnabled } from '@kass/shared';
import { Shell, type NavItem } from '@/components/Shell';

const NAV: NavItem[] = [
  { href: '/shop', label: 'dashboard', perms: ['reports.view'], group: 'overview' },
  { href: '/shop/products', label: 'products', perms: ['products.view'], group: 'catalog' },
  { href: '/shop/categories', label: 'categories', perms: ['products.view'], group: 'catalog' },
  { href: '/shop/prices', label: 'prices', perms: ['prices.view'], group: 'catalog' },
  { href: '/shop/promotions', label: 'promotions', perms: ['promotions.manage'], group: 'catalog' },
  { href: '/shop/stock', label: 'stock', perms: ['stock.view', 'stock.receipt'], group: 'stock' },
  { href: '/shop/receipts', label: 'receipts', perms: ['stock.receipt', 'stock.view'], group: 'stock' },
  { href: '/shop/transfers', label: 'transfers', perms: ['stock.transfer', 'stock.view'], group: 'stock' },
  { href: '/shop/writeoffs', label: 'writeoffs', perms: ['stock.writeoff', 'stock.view'], group: 'stock' },
  { href: '/shop/counts', label: 'counts', perms: ['stock.count', 'stock.view'], group: 'stock' },
  { href: '/shop/suppliers', label: 'suppliers', perms: ['suppliers.view', 'suppliers.manage'], group: 'stock' },
  { href: '/shop/customers', label: 'customers', perms: ['customers.view', 'customers.manage'], group: 'people' },
  { href: '/shop/staff', label: 'staff', perms: ['staff.manage', 'staff.cashiers'], group: 'people' },
  { href: '/shop/reports', label: 'reports', perms: ['reports.view', 'reports.stock'], group: 'reports' },
  { href: '/shop/branches', label: 'branches', perms: ['branches.manage'], group: 'company' },
  { href: '/shop/terminals', label: 'terminals', perms: ['terminals.manage'], group: 'company' },
  { href: '/shop/developers', label: 'developers', perms: ['developers.manage'], group: 'company' },
  { href: '/shop/settings', label: 'settings', perms: ['settings.manage'], group: 'company' },
  { href: '/shop/audit', label: 'audit', perms: ['audit.view'], group: 'company' },
];

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  // the warehouse ("Ombor": stock, receipts, transfers, write-offs, counts, suppliers) is off for now
  const nav = inventoryEnabled() ? NAV : NAV.filter((n) => n.group !== 'stock');
  return <Shell nav={nav} roles={['shop_admin', 'branch_manager', 'storekeeper']} ns="shop">{children}</Shell>;
}
