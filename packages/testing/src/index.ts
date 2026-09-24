/**
 * Shared test helpers (spec §3): fixtures, factories, MSW handlers, Testcontainers helpers.
 * Phase 0 ships only the environment fixture used by every package's unit tests.
 */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
  REDIS_URL: 'redis://localhost:6379/1',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'nexus-test',
  S3_ACCESS_KEY: 'nexus',
  S3_SECRET_KEY: 'nexus-secret',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-secret-test-secret-test-secret-test',
  KMS_MASTER_KEY_ID: 'local:test',
};
