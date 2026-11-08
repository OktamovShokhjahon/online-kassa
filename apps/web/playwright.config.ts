import { defineConfig } from '@playwright/test';

// Point the run at another stack (e.g. one started on other ports) with E2E_WEB_URL / E2E_API_URL.
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';

/**
 * End-to-end tests (spec section 13). They need the API with a MongoDB replica set and the web app:
 * the config starts `dev:stack` (in-memory replica set + API on :4000) and `next dev` unless they already run.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // one shared database, the steps build on each other's data
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'en-US' },
  webServer: [
    {
      command: 'npm run dev:stack --prefix ../..',
      url: `${API}/health`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'npm run dev -w @kass/web --prefix ../..',
      url: `${WEB}/login`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
