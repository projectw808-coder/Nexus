import { describe, expect, it } from 'vitest';
import {
  decryptToString,
  decryptWithDataKey,
  encryptWithDataKey,
  generateDataKey,
  generateMasterKeyBase64,
  localKeyProvider,
} from './envelope.ts';

describe('envelope encryption', () => {
  it('round-trips a secret under a data key with AAD binding', () => {
    const key = generateDataKey();
    const blob = encryptWithDataKey(key, 'tok_secret_value', {
      keyVersion: 'local:test',
      aad: 'vault:abc',
    });
    expect(blob.ciphertext).not.toContain('tok_secret');
    expect(Buffer.from(blob.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(blob.tag, 'base64')).toHaveLength(16);
    expect(decryptToString(key, blob, { aad: 'vault:abc' })).toBe('tok_secret_value');
    expect(() => decryptWithDataKey(key, blob, { aad: 'vault:other' })).toThrow(/authentication/);
    expect(() => decryptWithDataKey(generateDataKey(), blob, { aad: 'vault:abc' })).toThrow(
      /authentication/,
    );
  });

  it('detects tampering with the ciphertext', () => {
    const key = generateDataKey();
    const blob = encryptWithDataKey(key, 'hello', { keyVersion: 'v1' });
    const bytes = Buffer.from(blob.ciphertext, 'base64');
    bytes[0] = (bytes[0]! + 1) % 256;
    expect(() =>
      decryptWithDataKey(key, { ...blob, ciphertext: bytes.toString('base64') }),
    ).toThrow();
  });

  it('local key provider wraps and unwraps data keys and refuses foreign versions', async () => {
    const master = generateMasterKeyBase64();
    const provider = localKeyProvider({ masterKeyId: 'local:dev', masterKeyBase64: master });
    const dataKey = generateDataKey();
    const wrapped = await provider.wrapDataKey(dataKey);
    expect(wrapped.keyVersion).toBe('local:dev');
    expect(wrapped.wrapped).not.toContain(Buffer.from(dataKey).toString('base64'));
    expect(Buffer.from(await provider.unwrapDataKey(wrapped.wrapped, wrapped.keyVersion))).toEqual(
      Buffer.from(dataKey),
    );
    await expect(provider.unwrapDataKey(wrapped.wrapped, 'local:other')).rejects.toThrow(
      /wrapped by/,
    );
    const other = localKeyProvider({
      masterKeyId: 'local:dev',
      masterKeyBase64: generateMasterKeyBase64(),
    });
    await expect(other.unwrapDataKey(wrapped.wrapped, 'local:dev')).rejects.toThrow();
  });

  it('refuses non-local master key ids and short keys', () => {
    expect(() =>
      localKeyProvider({
        masterKeyId: 'arn:aws:kms:x',
        masterKeyBase64: generateMasterKeyBase64(),
      }),
    ).toThrow(/local:/);
    expect(() => localKeyProvider({ masterKeyId: 'local:x', masterKeyBase64: 'c2hvcnQ=' })).toThrow(
      /32 bytes/,
    );
  });
});
