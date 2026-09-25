/**
 * TokenVault (spec §5.4): `get` / `put` / `rotate` / `revoke` over `VaultEntry`, with envelope
 * encryption from the connector SDK — a per-workspace data key (`WorkspaceKey`, wrapped by the
 * KMS master key) encrypts each secret with AES-256-GCM, AAD-bound to the entry id.
 *
 * The plaintext never leaves this module except through `get()`, which only the connector
 * runtime calls; no tRPC procedure or REST route returns it (§5.4 "never return a token").
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NexusError } from '@nexus/core';
import {
  decryptToString,
  encryptWithDataKey,
  generateDataKey,
  tokenSetSchema,
  type KeyProvider,
  type TokenSet,
} from '@nexus/connector-sdk';
import type { VaultKind } from './generated/prisma/enums.ts';
import type { TenantDb } from './scoped.ts';

/**
 * Vault reads and writes always happen inside a tenant transaction: the web tier has the
 * user's actor, background jobs impersonate the connection's workspace via `systemActorFor`.
 */
export type VaultDb = TenantDb;

const payloadSchema = z.object({ v: z.literal(1), secret: z.string() });

export type VaultReadResult = {
  ref: string;
  kind: VaultKind;
  secret: string;
  version: number;
  expiresAt: Date | null;
  rotatedAt: Date;
};

export type Vault = {
  put(
    db: VaultDb,
    input: { workspaceId: string; kind: VaultKind; secret: string; expiresAt?: Date | null },
  ): Promise<{ ref: string; version: number }>;
  get(db: VaultDb, ref: string): Promise<VaultReadResult>;
  rotate(
    db: VaultDb,
    ref: string,
    secret: string,
    expiresAt?: Date | null,
  ): Promise<{ version: number }>;
  revoke(db: VaultDb, ref: string): Promise<void>;
  /**
   * Typed helpers for OAuth credentials. `kind` defaults to `OAUTH_TOKEN`; `api_key`
   * connectors (Keitaro) pass `API_KEY` so the vault row's kind reflects what it actually
   * holds even though the wire shape is still a `TokenSet` (`accessToken` IS the key).
   */
  putTokenSet(
    db: VaultDb,
    workspaceId: string,
    token: TokenSet,
    kind?: VaultKind,
  ): Promise<{ ref: string; version: number }>;
  getTokenSet(
    db: VaultDb,
    ref: string,
  ): Promise<{ token: TokenSet; version: number; rotatedAt: Date }>;
  rotateTokenSet(db: VaultDb, ref: string, token: TokenSet): Promise<{ version: number }>;
};

const aadFor = (workspaceId: string, ref: string): string => `vault:${workspaceId}:${ref}`;

export function createVault(opts: { keyProvider: KeyProvider }): Vault {
  const { keyProvider } = opts;
  // Unwrapped data keys, by WorkspaceKey id. Bounded: a process serves a bounded set of tenants.
  const cache = new Map<string, Uint8Array>();
  const remember = (id: string, key: Uint8Array) => {
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(id, key);
  };

  async function activeKey(
    db: VaultDb,
    workspaceId: string,
  ): Promise<{ id: string; key: Uint8Array; masterKeyId: string }> {
    const row = await db.workspaceKey.findFirst({
      where: { workspaceId, retiredAt: null },
      orderBy: { keyVersion: 'desc' },
    });
    if (row) {
      const cached = cache.get(row.id);
      if (cached) return { id: row.id, key: cached, masterKeyId: row.masterKeyId };
      const key = await keyProvider.unwrapDataKey(row.wrappedKey, row.masterKeyId);
      remember(row.id, key);
      return { id: row.id, key, masterKeyId: row.masterKeyId };
    }
    const key = generateDataKey();
    const wrapped = await keyProvider.wrapDataKey(key);
    const last = await db.workspaceKey.findFirst({
      where: { workspaceId },
      orderBy: { keyVersion: 'desc' },
      select: { keyVersion: true },
    });
    const created = await db.workspaceKey.create({
      data: {
        workspaceId,
        keyVersion: (last?.keyVersion ?? 0) + 1,
        wrappedKey: wrapped.wrapped,
        masterKeyId: wrapped.keyVersion,
      },
    });
    remember(created.id, key);
    return { id: created.id, key, masterKeyId: created.masterKeyId };
  }

  async function keyById(db: VaultDb, keyId: string): Promise<Uint8Array> {
    const cached = cache.get(keyId);
    if (cached) return cached;
    const row = await db.workspaceKey.findUnique({ where: { id: keyId } });
    if (!row) throw new NexusError('INTERNAL', { message: 'vault: data key row missing' });
    const key = await keyProvider.unwrapDataKey(row.wrappedKey, row.masterKeyId);
    remember(row.id, key);
    return key;
  }

  const encrypt = (
    key: Uint8Array,
    masterKeyId: string,
    workspaceId: string,
    ref: string,
    secret: string,
  ) =>
    encryptWithDataKey(
      key,
      JSON.stringify({ v: 1, secret } satisfies z.infer<typeof payloadSchema>),
      { keyVersion: masterKeyId, aad: aadFor(workspaceId, ref) },
    );

  const vault: Vault = {
    async put(db, input) {
      const ref = randomUUID();
      const k = await activeKey(db, input.workspaceId);
      const blob = encrypt(k.key, k.masterKeyId, input.workspaceId, ref, input.secret);
      await db.vaultEntry.create({
        data: {
          id: ref,
          workspaceId: input.workspaceId,
          kind: input.kind,
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          tag: blob.tag,
          keyId: k.id,
          expiresAt: input.expiresAt ?? null,
        },
      });
      return { ref, version: 1 };
    },

    async get(db, ref) {
      const row = await db.vaultEntry.findUnique({ where: { id: ref } });
      if (!row || row.revokedAt) {
        throw new NexusError('AUTH_EXPIRED', {
          message: row ? 'credential was revoked' : 'credential not found',
          details: { ref },
        });
      }
      const key = await keyById(db, row.keyId);
      const payload = payloadSchema.parse(
        JSON.parse(
          decryptToString(
            key,
            { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag, keyVersion: '' },
            { aad: aadFor(row.workspaceId, row.id) },
          ),
        ) as unknown,
      );
      return {
        ref: row.id,
        kind: row.kind,
        secret: payload.secret,
        version: row.version,
        expiresAt: row.expiresAt,
        rotatedAt: row.rotatedAt,
      };
    },

    async rotate(db, ref, secret, expiresAt) {
      const row = await db.vaultEntry.findUnique({
        where: { id: ref },
        select: { id: true, workspaceId: true, version: true, revokedAt: true },
      });
      if (!row)
        throw new NexusError('NOT_FOUND', { message: 'credential not found', details: { ref } });
      if (row.revokedAt)
        throw new NexusError('AUTH_EXPIRED', {
          message: 'credential was revoked',
          details: { ref },
        });
      const k = await activeKey(db, row.workspaceId);
      const blob = encrypt(k.key, k.masterKeyId, row.workspaceId, ref, secret);
      const next = row.version + 1;
      await db.vaultEntry.update({
        where: { id: ref },
        data: {
          ciphertext: blob.ciphertext,
          iv: blob.iv,
          tag: blob.tag,
          keyId: k.id,
          version: next,
          rotatedAt: new Date(),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
      });
      return { version: next };
    },

    async revoke(db, ref) {
      // Overwrite the ciphertext too: a revoked row keeps no recoverable secret.
      await db.vaultEntry.update({
        where: { id: ref },
        data: { revokedAt: new Date(), ciphertext: '', iv: '', tag: '' },
      });
    },

    async putTokenSet(db, workspaceId, token, kind) {
      return vault.put(db, {
        workspaceId,
        kind: kind ?? 'OAUTH_TOKEN',
        secret: JSON.stringify(tokenSetSchema.parse(token)),
        expiresAt: token.expiresAt ?? null,
      });
    },
    async getTokenSet(db, ref) {
      const r = await vault.get(db, ref);
      return {
        token: tokenSetSchema.parse(JSON.parse(r.secret) as unknown),
        version: r.version,
        rotatedAt: r.rotatedAt,
      };
    },
    async rotateTokenSet(db, ref, token) {
      return vault.rotate(
        db,
        ref,
        JSON.stringify(tokenSetSchema.parse(token)),
        token.expiresAt ?? null,
      );
    },
  };
  return vault;
}
