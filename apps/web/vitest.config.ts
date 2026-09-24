import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    passWithNoTests: true,
    environment: 'node',
    // Each PGlite-backed file owns an in-process Postgres; run files one at a time.
    fileParallelism: false,
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
});
