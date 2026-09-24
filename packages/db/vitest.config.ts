import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each PGlite-backed file owns an in-process Postgres; run files one at a time.
    fileParallelism: false,
    pool: 'forks',
  },
});
