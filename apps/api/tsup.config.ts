import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/scripts/seed-superadmin.ts', 'src/scripts/migrate.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // @kass/shared is TypeScript source: bundle it, keep every other dependency external
  noExternal: ['@kass/shared'],
});
