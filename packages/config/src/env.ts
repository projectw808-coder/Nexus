/**
 * Zod-validated environment (spec Appendix A). Loaded once, fails fast at boot with every
 * problem listed, never one at a time. Platform credentials are optional at boot: a connector
 * validates its own block when a connection of that platform is first enabled, so a workspace
 * that never connects TikTok is not forced to configure TikTok.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const bool = (def: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

/** Optional string that treats "" as absent — .env files commonly leave keys empty. */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SERVICE_NAME: z.string().default('nexus'),

  // ── infrastructure ───────────────────────────────────────────────────────
  /** postgres(ql):// for the pg adapter, or pglite://<dir> for the in-process dev backend (ADR-008). */
  DATABASE_URL: z
    .string()
    .refine(
      (u) => /^(postgres(ql)?|pglite):\/\//.test(u),
      'must be a postgres:// or pglite:// URL',
    ),
  /** Table-owner URL for migrations and the drift gate. Falls back to DATABASE_URL. */
  DATABASE_ADMIN_URL: optional,
  SHADOW_DATABASE_URL: optional,
  REDIS_URL: z.url().refine((u) => u.startsWith('redis'), 'must be a redis:// URL'),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_FORCE_PATH_STYLE: bool('true'),

  // ── app ──────────────────────────────────────────────────────────────────
  APP_URL: z.url(),
  WEB_PORT: int(3000),
  WORKER_HEALTH_PORT: int(3001),
  AUTH_SECRET: z.string().min(32),
  KMS_MASTER_KEY_ID: z.string().min(1),
  /** 32 bytes, base64. Used when KMS_MASTER_KEY_ID is `local:*` (dev/test only). */
  ENCRYPTION_KEY_FALLBACK: optional,

  // ── auth & mail ──────────────────────────────────────────────────────────
  SMTP_URL: optional,
  EMAIL_FROM: z.string().default('Nexus <no-reply@nexus.local>'),
  AUTH_MICROSOFT_ENTRA_ID_ID: optional,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: optional,
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: optional,
  AUTH_TRUST_HOST: bool('true'),

  // ── Meta ─────────────────────────────────────────────────────────────────
  META_APP_ID: optional,
  META_APP_SECRET: optional,
  META_WEBHOOK_VERIFY_TOKEN: optional,
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v26.0'),

  // ── X ────────────────────────────────────────────────────────────────────
  X_CLIENT_ID: optional,
  X_CLIENT_SECRET: optional,
  X_BILLING_MODE: z.enum(['payg', 'enterprise']).default('payg'),
  X_CYCLE_SPEND_CAP_USD: z.coerce.number().nonnegative().optional(),
  X_CYCLE_POST_READ_CAP: int(3_000_000),
  X_SPEND_ALERT_PCT: z.coerce.number().min(1).max(100).default(80),

  // ── LinkedIn ─────────────────────────────────────────────────────────────
  LINKEDIN_CLIENT_ID: optional,
  LINKEDIN_CLIENT_SECRET: optional,
  LINKEDIN_API_VERSION: z
    .string()
    .regex(/^\d{6}$/, 'YYYYMM')
    .optional(),

  // ── TikTok ───────────────────────────────────────────────────────────────
  TIKTOK_CLIENT_KEY: optional,
  TIKTOK_CLIENT_SECRET: optional,
  TIKTOK_WEBHOOK_SECRET: optional,

  // ── Google / YouTube ─────────────────────────────────────────────────────
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  GOOGLE_PUBSUB_TOPIC: optional,
  YOUTUBE_DAILY_UNIT_BUDGET: int(10_000),
  YOUTUBE_SEARCH_DAILY_CALLS: int(100),
  YOUTUBE_INSERT_DAILY_CALLS: int(100),

  // ── Keitaro defaults (base URL + key live on the Connection, not here) ───
  KEITARO_DEFAULT_RPS: z.coerce.number().positive().default(2),
  KEITARO_DEFAULT_CONCURRENCY: int(2),
  KEITARO_WEBHOOK_SECRET_BYTES: int(32),

  // ── AI ───────────────────────────────────────────────────────────────────
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'self_hosted', 'disabled']).default('disabled'),
  AI_API_KEY: optional,
  AI_MONTHLY_TOKEN_BUDGET: int(0),
  AI_PII_REDACTION: z.enum(['strict', 'standard', 'off']).default('strict'),

  // ── observability ────────────────────────────────────────────────────────
  OTEL_EXPORTER_OTLP_ENDPOINT: optional,
  OTEL_SERVICE_NAMESPACE: z.string().default('nexus'),
  SENTRY_DSN: optional,

  // ── feature flags ────────────────────────────────────────────────────────
  FEATURE_GMAIL: bool(),
  FEATURE_ADS: bool(),
  FEATURE_MOCK_PLATFORM: bool('true'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  constructor(readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(`Invalid environment:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')}`);
  }
}

/**
 * Parse a raw environment. Pure; does not read process.env. Empty strings are treated as unset
 * (.env files commonly leave keys blank), so an optional key with a format rule is not rejected
 * for being blank and a blank numeric key does not coerce to 0.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => ({
        path: i.path.map(String).join('.') || '(root)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Locate the repo-root `.env` (the directory holding pnpm-workspace.yaml, searched upward from
 * cwd) and merge it into process.env without overriding values already set. Both apps run
 * from their own directories, and Next.js only reads `.env` files next to itself, so this is
 * what makes one root `.env` serve web, worker and scripts alike. `NEXUS_ENV_FILE` overrides.
 */
function loadRootDotenv(): void {
  const explicit = process.env['NEXUS_ENV_FILE'];
  if (explicit) {
    loadDotenv({ path: explicit, quiet: true, override: false });
    return;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      loadDotenv({ path: join(dir, '.env'), quiet: true, override: false });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Load and cache process.env. Throws EnvValidationError with every problem on first call. */
export function loadEnv(): Env {
  if (!cached) {
    loadRootDotenv();
    cached = parseEnv(process.env);
  }
  return cached;
}

/** Test hook. */
export function resetEnvCache(): void {
  cached = undefined;
}
