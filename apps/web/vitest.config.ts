import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
  // The app's tsconfig says `jsx: preserve` (Next compiles it); the test runner has to compile
  // it itself, so the chart component tests can render real markup.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    passWithNoTests: true,
    environment: 'node',
    // Each PGlite-backed file owns an in-process Postgres; run files one at a time.
    fileParallelism: false,
    pool: 'forks',
    env: { NODE_ENV: 'test' },
  },
});
