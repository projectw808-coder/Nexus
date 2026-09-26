import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // PGlite-backed suites own an in-process Postgres each; run files one at a time.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
