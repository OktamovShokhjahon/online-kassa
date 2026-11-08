import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route-group protection by role (spec 3.2). The `kass_role` cookie is only a routing hint set by
 * the API at login; every API call is authorised again by the server, so forging the cookie reveals
 * nothing but an empty page.
 */
const HOME: Record<string, string> = { superadmin: '/superadmin', shop_admin: '/shop', branch_manager: '/shop', storekeeper: '/shop', cashier: '/pos' };

export function middleware(req: NextRequest) {
  const role = req.cookies.get('kass_role')?.value ?? '';
  const { pathname } = req.nextUrl;
  const go = (to: string) => NextResponse.redirect(new URL(to, req.url));

  if (!role || !HOME[role]) return go('/login');
  if (pathname.startsWith('/superadmin') && role !== 'superadmin') return go(HOME[role]);
  if (pathname.startsWith('/shop') && (role === 'superadmin' || role === 'cashier')) return go(HOME[role]);
  if (pathname.startsWith('/pos') && role === 'superadmin') return go(HOME[role]);
  return NextResponse.next();
}

export const config = { matcher: ['/superadmin/:path*', '/shop/:path*', '/pos/:path*'] };
