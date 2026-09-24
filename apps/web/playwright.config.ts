import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (spec §15): the app runs on the in-process PGlite backend seeded by
 * e2e/seed.ts (100k records, a pipeline, two users), with the test-only sign-in endpoint
 * enabled (ADR-012). `next start` serves the production build on :3200.
 */
const PORT = 3200;
const DATA_DIR = './.data/e2e';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `pnpm e2e:seed && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/sign-in`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: `pglite://${DATA_DIR}`,
      E2E_AUTH_BYPASS: 'true',
      APP_URL: `http://localhost:${PORT}`,
      SMTP_URL: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      REDIS_URL: 'redis://localhost:6399',
    },
  },
});
