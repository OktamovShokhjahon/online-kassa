import { Shell, type NavItem } from '@/components/Shell';

const NAV: NavItem[] = [
  { href: '/superadmin', label: 'dashboard' },
  { href: '/superadmin/shops', label: 'shops' },
  { href: '/superadmin/audit', label: 'audit' },
  { href: '/superadmin/settings', label: 'settings' },
];

export default function SuperadminLayout({ children }: { children: React.ReactNode }) {
  return <Shell nav={NAV} roles={['superadmin']} ns="sa">{children}</Shell>;
}
