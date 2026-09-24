import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from './env.ts';
import { isEnabled } from './flags.ts';

const minimal = {
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'nexus',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio-secret',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'x'.repeat(32),
  KMS_MASTER_KEY_ID: 'local:dev',
};

describe('env', () => {
  it('parses a minimal dev environment with defaults', () => {
    const env = parseEnv(minimal);
    expect(env.NODE_ENV).toBe('development');
    expect(env.META_API_VERSION).toBe('v26.0');
    expect(env.X_BILLING_MODE).toBe('payg');
    expect(env.YOUTUBE_SEARCH_DAILY_CALLS).toBe(100);
    expect(env.FEATURE_GMAIL).toBe(false);
    expect(env.FEATURE_MOCK_PLATFORM).toBe(true);
  });

  it('reports every missing variable at once', () => {
    let caught: unknown;
    try {
      parseEnv({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const issues = (caught as EnvValidationError).issues.map((i) => i.path);
    expect(issues).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'APP_URL', 'AUTH_SECRET', 'S3_BUCKET']),
    );
  });

  it('rejects a short AUTH_SECRET and a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...minimal, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...minimal, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('treats empty optional strings as absent', () => {
    const env = parseEnv({ ...minimal, META_APP_ID: '' });
    expect(env.META_APP_ID).toBeUndefined();
  });

  it('flags: workspace override beats env', () => {
    const env = parseEnv({ ...minimal, FEATURE_GMAIL: 'false' });
    expect(isEnabled('gmail', env)).toBe(false);
    expect(isEnabled('gmail', env, { gmail: true })).toBe(true);
  });
});

describe('env: blank values', () => {
  it('a blank optional key with a format rule is treated as unset', () => {
    const env = parseEnv({ ...minimal, LINKEDIN_API_VERSION: '', X_CYCLE_SPEND_CAP_USD: '' });
    expect(env.LINKEDIN_API_VERSION).toBeUndefined();
    expect(env.X_CYCLE_SPEND_CAP_USD).toBeUndefined();
  });
});

describe('env: database backends', () => {
  it('accepts pglite:// as well as postgres://', () => {
    expect(parseEnv({ ...minimal, DATABASE_URL: 'pglite://./.data/nexus' }).DATABASE_URL).toBe(
      'pglite://./.data/nexus',
    );
    expect(() => parseEnv({ ...minimal, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });
});
