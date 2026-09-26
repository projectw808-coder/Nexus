/**
 * Workspace API keys (spec §11.2, ADR-022): the credential REST v1 authenticates with.
 *
 * The plaintext is shown exactly once, at creation; only its SHA-256 and a short prefix are
 * stored. Presenting a key resolves an `Actor` whose `actorType` is `API_KEY` and whose
 * `userId` is null — full trust *within* the tenant, exactly like `systemActorFor`, because
 * CASL only runs in the tRPC layer and REST v1 never touches it. What a key may do is decided
 * by its `ApiKeyScope[]`, enforced per route by the REST auth middleware, not by CASL.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from '../generated/prisma/enums.ts';
import type { Actor, TenantDb, TenantRuntime } from '../scoped.ts';

/** `nx_live_` + 32 url-safe characters. The prefix shown in the UI is the first 12. */
export const API_KEY_PLAINTEXT_PREFIX = 'nx_live_';
export const API_KEY_RANDOM_CHARS = 32;
export const API_KEY_PREFIX_LENGTH = 12;

const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type GeneratedApiKey = { plaintext: string; prefix: string; hash: string };

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Cryptographically random key material — never `Math.random`. */
export function generateApiKey(): GeneratedApiKey {
  // Rejection-free: 64 symbols is a power of two, so masking 6 bits per byte is unbiased.
  const bytes = randomBytes(API_KEY_RANDOM_CHARS);
  let random = '';
  for (const b of bytes) random += URL_SAFE[b & 0x3f];
  const plaintext = `${API_KEY_PLAINTEXT_PREFIX}${random}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, API_KEY_PREFIX_LENGTH),
    hash: hashApiKey(plaintext),
  };
}

export type CreateApiKeyInput = {
  name: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute?: number | null;
  expiresAt?: Date | null;
};

export type CreatedApiKey = { id: string; plaintext: string; prefix: string };

/** The ONLY place a plaintext key is ever returned. */
export async function createApiKey(
  db: TenantDb,
  actor: Actor,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const row = await db.apiKey.create({
    data: {
      workspaceId: actor.workspaceId,
      name: input.name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scopes: input.scopes.length > 0 ? input.scopes : ['READ'],
      rateLimitPerMinute: input.rateLimitPerMinute ?? null,
      expiresAt: input.expiresAt ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  });
  return { id: row.id, plaintext: generated.plaintext, prefix: generated.prefix };
}

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdById: string | null;
};

/** Never selects `keyHash` — there is nothing a caller could legitimately do with it. */
export async function listApiKeys(db: TenantDb, workspaceId: string): Promise<ApiKeyRow[]> {
  return db.apiKey.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      rateLimitPerMinute: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      createdById: true,
    },
  });
}

/** Revocation is immediate and irreversible; the row is kept so the audit trail still resolves. */
export async function revokeApiKey(db: TenantDb, id: string): Promise<void> {
  await db.apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
}

export type ResolvedApiKey = {
  workspaceId: string;
  actor: Actor;
  apiKeyId: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number | null;
};

/** The actor a presented API key acts as: owner-level inside its own workspace, no user. */
export function apiKeyActor(workspaceId: string, apiKeyId: string): Actor {
  return {
    workspaceId,
    userId: null,
    role: 'OWNER',
    grants: [],
    actorType: 'API_KEY',
    actorRef: apiKeyId,
  };
}

function looksLikeApiKey(plaintext: string): boolean {
  return (
    plaintext.startsWith(API_KEY_PLAINTEXT_PREFIX) &&
    plaintext.length === API_KEY_PLAINTEXT_PREFIX.length + API_KEY_RANDOM_CHARS
  );
}

/**
 * Hash the presented key and look it up **unscoped** — the workspace is not known until this
 * call determines it, which is precisely why it needs `withSystem` (ADR-006). Returns null for
 * an unknown, revoked or expired key; `lastUsedAt` is refreshed best-effort in a transaction of
 * its own, so a failed write never fails the request.
 */
export async function resolveApiKeyActor(
  runtime: TenantRuntime,
  plaintextKey: string,
): Promise<ResolvedApiKey | null> {
  const presented = plaintextKey.trim();
  if (!looksLikeApiKey(presented)) return null;
  const hash = hashApiKey(presented);
  const row = await runtime.withSystem((db) =>
    db.apiKey.findFirst({
      where: { keyHash: hash, deletedAt: null },
      select: {
        id: true,
        workspaceId: true,
        keyHash: true,
        scopes: true,
        rateLimitPerMinute: true,
        revokedAt: true,
        expiresAt: true,
      },
    }),
  );
  if (!row) return null;
  // Belt over the unique index: constant-time compare so a partial-hash oracle cannot exist.
  const a = Buffer.from(row.keyHash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) return null;

  try {
    await runtime.withSystem((db) =>
      db.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }),
    );
  } catch {
    // Best effort: a busy or read-only database must not turn into a 500 for the caller.
  }

  return {
    workspaceId: row.workspaceId,
    actor: apiKeyActor(row.workspaceId, row.id),
    apiKeyId: row.id,
    scopes: row.scopes,
    rateLimitPerMinute: row.rateLimitPerMinute,
  };
}

const SCOPE_RANK: Record<ApiKeyScope, number> = { READ: 1, WRITE: 2, ADMIN: 3 };

/**
 * Scopes are a ladder, not a set of unrelated flags: WRITE implies READ, ADMIN implies both.
 * A key holding `[WRITE]` therefore satisfies a READ route without also listing READ.
 */
export function hasApiScope(held: readonly ApiKeyScope[], required: ApiKeyScope): boolean {
  const max = held.reduce((m, s) => Math.max(m, SCOPE_RANK[s]), 0);
  return max >= SCOPE_RANK[required];
}
