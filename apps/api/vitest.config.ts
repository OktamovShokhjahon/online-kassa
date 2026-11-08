import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Tests share one in-memory replica set; run files one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      BCRYPT_COST: '4',
      RUN_WORKERS: 'false',
      WEB_ORIGIN: 'http://localhost:3000',
      // the suite covers the warehouse too; tests of the warehouse-off mode switch it per test
      KASS_INVENTORY: 'true',
    },
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text-summary', 'html'] },
  },
});
