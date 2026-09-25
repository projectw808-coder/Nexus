import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signHmacSha256,
  verifyHmacSha256,
  verifyJwtRs256,
  verifySharedSecret,
} from './webhooks.ts';

describe('HMAC verification', () => {
  const body = Buffer.from('{"entry":[{"id":"1"}]}');
  it('accepts a correct signature and rejects tampering, wrong secrets and missing headers', () => {
    const sig = signHmacSha256(body, 'app-secret');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyHmacSha256({ rawBody: body, secret: 'app-secret', signature: sig })).toBe(true);
    expect(
      verifyHmacSha256({
        rawBody: Buffer.from('{"entry":[{"id":"2"}]}'),
        secret: 'app-secret',
        signature: sig,
      }),
    ).toBe(false);
    expect(verifyHmacSha256({ rawBody: body, secret: 'other', signature: sig })).toBe(false);
    expect(verifyHmacSha256({ rawBody: body, secret: 'app-secret', signature: undefined })).toBe(
      false,
    );
    expect(verifyHmacSha256({ rawBody: body, secret: 'app-secret', signature: 'sha256=00' })).toBe(
      false,
    );
  });
  it('supports base64 signatures without a prefix', () => {
    const sig = signHmacSha256('abc', 's', { prefix: '', encoding: 'base64' });
    expect(
      verifyHmacSha256({
        rawBody: 'abc',
        secret: 's',
        signature: sig,
        prefix: '',
        encoding: 'base64',
      }),
    ).toBe(true);
  });
});

describe('shared secret', () => {
  it('compares in constant time and rejects empties', () => {
    expect(verifySharedSecret('abc', 'abc')).toBe(true);
    expect(verifySharedSecret('abd', 'abc')).toBe(false);
    expect(verifySharedSecret(undefined, 'abc')).toBe(false);
    expect(verifySharedSecret('', '')).toBe(false);
  });
});

describe('RS256 JWT', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const make = (claims: Record<string, unknown>, kid = 'k1') => {
    const h = b64({ alg: 'RS256', typ: 'JWT', kid });
    const p = b64(claims);
    const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const now = () => 1_700_000_000_000;

  it('verifies a valid token with audience and issuer', () => {
    const tok = make({
      iss: 'https://accounts.google.com',
      aud: 'https://app/webhooks',
      exp: 1_700_000_600,
      email: 'svc@x',
    });
    const claims = verifyJwtRs256(tok, {
      jwks: { keys: [jwk] },
      audience: 'https://app/webhooks',
      issuer: 'https://accounts.google.com',
      now,
    });
    expect(claims?.email).toBe('svc@x');
  });
  it('rejects expiry, wrong audience, wrong key and tampering', () => {
    expect(
      verifyJwtRs256(make({ aud: 'a', exp: 1_699_999_000 }), {
        jwks: { keys: [jwk] },
        audience: 'a',
        now,
      }),
    ).toBeNull();
    expect(
      verifyJwtRs256(make({ aud: 'b', exp: 1_700_000_600 }), {
        jwks: { keys: [jwk] },
        audience: 'a',
        now,
      }),
    ).toBeNull();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
      format: 'jwk',
    });
    expect(
      verifyJwtRs256(make({ aud: 'a', exp: 1_700_000_600 }), {
        jwks: { keys: [{ ...other, kid: 'k1' }] },
        audience: 'a',
        now,
      }),
    ).toBeNull();
    const tok = make({ aud: 'a', exp: 1_700_000_600 });
    const [h, , s] = tok.split('.') as [string, string, string];
    expect(
      verifyJwtRs256(`${h}.${b64({ aud: 'a', exp: 1_800_000_000 })}.${s}`, {
        jwks: { keys: [jwk] },
        audience: 'a',
        now,
      }),
    ).toBeNull();
    expect(verifyJwtRs256('garbage', { jwks: { keys: [jwk] } })).toBeNull();
  });
});
