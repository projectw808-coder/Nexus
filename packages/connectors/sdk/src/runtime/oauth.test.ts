import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import type { HttpClient, HttpRequest } from '../spi.ts';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  mintOauthState,
  parseTokenResponse,
  refreshAccessToken,
  revokeToken,
  tokenLifecycle,
  verifyOauthState,
} from './oauth.ts';

function fakeHttp(
  handler: (req: HttpRequest) => { status: number; body: unknown },
): HttpClient & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const r = handler(req);
      const bodyText = JSON.stringify(r.body);
      return {
        status: r.status,
        headers: {},
        bodyText,
        json: () => JSON.parse(bodyText) as unknown,
      };
    },
  };
}

describe('PKCE and state', () => {
  it('mints an S256 pair', () => {
    const p = generatePkcePair();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.method).toBe('S256');
    expect(p.challenge).not.toBe(p.verifier);
  });

  it('signs and verifies state, rejecting tampering and expiry', () => {
    const state = mintOauthState('s3cret', {
      workspaceId: 'ws',
      platform: 'MOCK',
      userId: 'u1',
      returnTo: '/w/acme',
    });
    const payload = verifyOauthState('s3cret', state);
    expect(payload.workspaceId).toBe('ws');
    expect(payload.returnTo).toBe('/w/acme');
    expect(() => verifyOauthState('other', state)).toThrow(/signature/);
    const [body, sig] = state.split('.') as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ ...payload, workspaceId: 'evil' })).toString('base64url')}.${sig}`;
    expect(() => verifyOauthState('s3cret', forged)).toThrow(/signature/);
    expect(() =>
      verifyOauthState('s3cret', `${body}.${sig}`, { now: () => Date.now() + 11 * 60_000 }),
    ).toThrow(/expired/);
  });

  it('builds an authorization URL with PKCE and extras', () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizeUrl: 'https://auth.example/authorize',
        clientId: 'cid',
        redirectUri: 'https://app/cb',
        scopes: ['a', 'b'],
        state: 'st',
        pkce: { verifier: 'v', challenge: 'c', method: 'S256' },
        extraParams: { access_type: 'offline' },
      }),
    );
    expect(url.searchParams.get('code_challenge')).toBe('c');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('token endpoint', () => {
  it('exchanges a code and parses expiry and scopes', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        scope: 'a b',
        token_type: 'bearer',
      },
    }));
    const t = await exchangeAuthorizationCode(http, {
      tokenUrl: 'https://auth/token',
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'code',
      redirectUri: 'https://app/cb',
      verifier: 'ver',
    });
    expect(t.accessToken).toBe('at');
    expect(t.refreshToken).toBe('rt');
    expect(t.scopes).toEqual(['a', 'b']);
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    const sent = new URLSearchParams(String(http.calls[0]!.body));
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code_verifier')).toBe('ver');
    expect(sent.get('client_secret')).toBe('sec');
  });

  it('uses basic auth when asked and keeps the old refresh token on refresh', async () => {
    const http = fakeHttp(() => ({ status: 200, body: { access_token: 'new', expires_in: 60 } }));
    const t = await refreshAccessToken(http, {
      tokenUrl: 'https://auth/token',
      clientId: 'cid',
      clientSecret: 'sec',
      auth: 'basic',
      token: {
        accessToken: 'old',
        refreshToken: 'keep',
        scopes: ['x'],
        tokenType: 'Bearer',
        raw: {},
      },
    });
    expect(t.accessToken).toBe('new');
    expect(t.refreshToken).toBe('keep');
    expect(t.scopes).toEqual(['x']);
    expect(http.calls[0]!.headers!.authorization).toMatch(/^Basic /);
    expect(new URLSearchParams(String(http.calls[0]!.body)).get('client_secret')).toBeNull();
  });

  it('maps invalid_grant to AUTH_EXPIRED and refuses to refresh without a refresh token', async () => {
    const http = fakeHttp(() => ({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'revoked' },
    }));
    await expect(
      refreshAccessToken(http, {
        tokenUrl: 'u',
        clientId: 'c',
        token: { accessToken: 'a', refreshToken: 'r', scopes: [], tokenType: 'Bearer', raw: {} },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    await expect(
      refreshAccessToken(http, {
        tokenUrl: 'u',
        clientId: 'c',
        token: { accessToken: 'a', scopes: [], tokenType: 'Bearer', raw: {} },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('flags an unexpected token response shape as SCHEMA_DRIFT', () => {
    expect(() => parseTokenResponse({ token: 'x' })).toThrow(NexusError);
    try {
      parseTokenResponse({ token: 'x' });
    } catch (e) {
      expect((e as NexusError).code).toBe('SCHEMA_DRIFT');
    }
  });

  it('revoke tolerates 404 and surfaces other failures', async () => {
    await expect(
      revokeToken(
        fakeHttp(() => ({ status: 404, body: {} })),
        { revokeUrl: 'u', clientId: 'c', token: 't' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      revokeToken(
        fakeHttp(() => ({ status: 500, body: {} })),
        { revokeUrl: 'u', clientId: 'c', token: 't' },
      ),
    ).rejects.toMatchObject({ code: 'PLATFORM_DOWN' });
  });
});

describe('token lifecycle', () => {
  const issuedAt = new Date('2026-09-01T00:00:00Z');
  const expiresAt = new Date('2026-09-11T00:00:00Z'); // 10-day lifetime
  it('is fresh before 70% and refresh_due after', () => {
    const t = { expiresAt, refreshToken: 'r' };
    expect(tokenLifecycle(t, { issuedAt, now: new Date('2026-09-05T00:00:00Z') })).toMatchObject({
      state: 'fresh',
    });
    expect(tokenLifecycle(t, { issuedAt, now: new Date('2026-09-08T00:00:00Z') })).toMatchObject({
      state: 'refresh_due',
    });
    expect(tokenLifecycle(t, { issuedAt, now: new Date('2026-09-12T00:00:00Z') })).toMatchObject({
      state: 'expired',
    });
  });
  it('warns seven days out when there is no refresh path', () => {
    const t = { expiresAt, refreshToken: undefined };
    expect(tokenLifecycle(t, { issuedAt, now: new Date('2026-09-02T00:00:00Z') })).toMatchObject({
      state: 'fresh',
    });
    expect(tokenLifecycle(t, { issuedAt, now: new Date('2026-09-05T00:00:00Z') })).toMatchObject({
      state: 'reconnect_soon',
    });
    expect(tokenLifecycle({ refreshToken: 'r' }, { issuedAt })).toEqual({ state: 'no_expiry' });
  });
});
