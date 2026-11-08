import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
// Where the API runs (on Vercel: the Render address, e.g. https://online-kass-api.onrender.com).
// Read at build time: set it in Vercel before deploying.
const API_URL = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@kass/shared'],
  reactStrictMode: true,
  // a second dev server (e.g. for an isolated e2e run) needs its own build folder
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  // in a monorepo the standalone trace must start at the repository root
  experimental: { outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../../') },
  // The browser talks to the API through the web origin, so the refresh cookie stays first-party.
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` },
      { source: '/uploads/:path*', destination: `${API_URL}/uploads/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // The POS talks to the local agent on loopback.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
