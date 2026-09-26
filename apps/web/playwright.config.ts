import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (spec §15): the app runs on the in-process PGlite backend seeded by
 * e2e/seed.ts (100k records, a pipeline, two users), with the test-only sign-in endpoint
 * enabled (ADR-012). `next start` serves the production build on :3200.
 */
const PORT = 3200;
const DATA_DIR = './.data/e2e';

const CI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: './e2e',
  // A shared 2-vCPU GitHub-hosted runner is meaningfully slower than a dev machine for this
  // PGlite-backed suite at 100k+ rows — run #4 timed out waiting for elements (not wrong
  // content) across scattered specs, and retries didn't help, which is the signature of too
  // little headroom rather than a race condition. Doubled for CI only; local stays tight.
  timeout: CI ? 180_000 : 90_000,
  expect: { timeout: CI ? 30_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // Seeds, frees the port (an orphaned server would share it on Windows), then owns `next start`.
    command: `node e2e/server.cjs`,
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
      E2E_PORT: String(PORT),
      // The mock platform is served by the app itself under E2E_AUTH_BYPASS (server/e2e-mock.ts).
      MOCK_PLATFORM_URL: `http://localhost:${PORT}/api/e2e/mock`,
    },
  },
});
