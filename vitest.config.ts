import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/coaching/**', 'lib/metrics/**', 'lib/profile/**', 'lib/analysis/taxonomy.ts'],
      reporter: ['text-summary'],
    },
    testTimeout: 60000,
    hookTimeout: 60000,
    // PGlite instances are process-wide; parallel integration files would fight over one
    // database handle.
    fileParallelism: false,
  },
});
