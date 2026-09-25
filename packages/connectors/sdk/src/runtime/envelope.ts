/**
 * Envelope encryption for tokens and secrets (spec §5.4): AES-256-GCM with a per-workspace
 * data key, itself wrapped by a master key held by a `KeyProvider`. What is persisted is
 * `{ ciphertext, iv, tag, keyVersion }` for the secret and `{ wrapped, keyVersion }` for the
 * data key — never a plaintext key, never a plaintext token.
 *
 * The `KeyProvider` is the KMS seam. `localKeyProvider` wraps with a key from the environment
 * and is the dev/test/CI provider (ADR-014); a cloud KMS provider implements the same two
 * methods with `Encrypt`/`Decrypt` calls.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NexusError } from '@nexus/core';

export const encryptedBlobSchema = z.object({
  /** base64 */
  ciphertext: z.string(),
  /** base64, 12 bytes */
  iv: z.string(),
  /** base64, 16 bytes */
  tag: z.string(),
  /** Which master key version wrapped the data key that encrypted this blob. */
  keyVersion: z.string().min(1),
});
export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>;

export interface KeyProvider {
  /** Identifier of the master key (`local:dev`, `arn:aws:kms:…`). Persisted as `keyVersion`. */
  readonly masterKeyId: string;
  wrapDataKey(plainKey: Uint8Array): Promise<{ wrapped: string; keyVersion: string }>;
  unwrapDataKey(wrapped: string, keyVersion: string): Promise<Uint8Array>;
}

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function generateDataKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

function assertKey(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) {
    throw new NexusError('INTERNAL', { message: `data key must be ${KEY_BYTES} bytes` });
  }
  return Buffer.from(key);
}

/** Encrypt bytes or a UTF-8 string under a 32-byte data key. `aad` binds the blob to a context (the vault ref). */
export function encryptWithDataKey(
  dataKey: Uint8Array,
  plaintext: Uint8Array | string,
  opts: { keyVersion: string; aad?: string },
): EncryptedBlob {
  const key = assertKey(dataKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  if (opts.aad) cipher.setAAD(Buffer.from(opts.aad, 'utf8'));
  const input =
    typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: opts.keyVersion,
  };
}

export function decryptWithDataKey(
  dataKey: Uint8Array,
  blob: EncryptedBlob,
  opts: { aad?: string } = {},
): Uint8Array {
  const key = assertKey(dataKey);
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
    if (opts.aad) decipher.setAAD(Buffer.from(opts.aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return new Uint8Array(
      Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]),
    );
  } catch (cause) {
    throw new NexusError('INTERNAL', {
      message: 'vault blob failed authentication (wrong key, tampered blob or wrong context)',
      cause,
    });
  }
}

export function decryptToString(
  dataKey: Uint8Array,
  blob: EncryptedBlob,
  opts: { aad?: string } = {},
): string {
  return Buffer.from(decryptWithDataKey(dataKey, blob, opts)).toString('utf8');
}

/**
 * Master key from the environment (`KMS_MASTER_KEY_ID=local:<name>` +
 * `ENCRYPTION_KEY_FALLBACK=<32 bytes base64>`). Wraps data keys with AES-256-GCM under that key.
 * Refuses to be constructed for a non-`local:` id so production cannot silently fall back.
 */
export function localKeyProvider(opts: {
  masterKeyId: string;
  masterKeyBase64: string;
}): KeyProvider {
  if (!opts.masterKeyId.startsWith('local:')) {
    throw new NexusError('VALIDATION', {
      message: `localKeyProvider only serves "local:*" master key ids (got ${opts.masterKeyId})`,
    });
  }
  const master = Buffer.from(opts.masterKeyBase64, 'base64');
  if (master.byteLength !== KEY_BYTES) {
    throw new NexusError('VALIDATION', {
      message: 'ENCRYPTION_KEY_FALLBACK must be exactly 32 bytes, base64-encoded',
    });
  }
  const masterKeyId = opts.masterKeyId;
  return {
    masterKeyId,
    async wrapDataKey(plainKey) {
      const blob = encryptWithDataKey(new Uint8Array(master), plainKey, {
        keyVersion: masterKeyId,
        aad: `datakey:${masterKeyId}`,
      });
      return { wrapped: JSON.stringify(blob), keyVersion: masterKeyId };
    },
    async unwrapDataKey(wrapped, keyVersion) {
      if (keyVersion !== masterKeyId) {
        throw new NexusError('INTERNAL', {
          message: `data key was wrapped by ${keyVersion}; this provider holds ${masterKeyId}`,
        });
      }
      const blob = encryptedBlobSchema.parse(JSON.parse(wrapped) as unknown);
      return decryptWithDataKey(new Uint8Array(master), blob, { aad: `datakey:${masterKeyId}` });
    },
  };
}

/** A fresh random master key, base64 — for tests and for generating `ENCRYPTION_KEY_FALLBACK`. */
export function generateMasterKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
