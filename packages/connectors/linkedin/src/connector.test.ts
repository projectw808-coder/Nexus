import { describe, expect, it } from 'vitest';
import { NexusError } from '@nexus/core';
import { defineConnectorContract } from '@nexus/connector-sdk/contract';
import { createTestConnCtx, createTestNormalizeCtx } from '@nexus/connector-sdk/testing';
import { createLinkedinConnector, type LinkedinConfig } from './connector.ts';
import { linkedinManifest, KINDS } from './manifest.ts';
import {
  createLinkedInDouble,
  leadFixture,
  leadWebhookPayload,
} from './testing/linkedin-double.ts';
import liPost from './fixtures/li_post.json' with { type: 'json' };
import liPostDrift from './fixtures/li_post.drift.json' with { type: 'json' };
import liComment from './fixtures/li_comment.json' with { type: 'json' };
import liLead from './fixtures/li_lead.json' with { type: 'json' };

const config: LinkedinConfig = { baseUrl: 'https://api.linkedin.example.test' };
const connector = createLinkedinConnector(config);
const orgUrn = 'urn:li:organization:123456';

const MEMBER_ONLY_SCOPES = ['openid', 'profile', 'email'];

function ctxFor(
  double: ReturnType<typeof createLinkedInDouble>,
  extra: Partial<Parameters<typeof createTestConnCtx<LinkedinConfig>>[0]> = {},
) {
  return createTestConnCtx<LinkedinConfig>({
    manifest: linkedinManifest,
    fetch: double.fetch,
    config,
    accountExternalId: orgUrn,
    token: {
      accessToken: double.accessToken,
      scopes: linkedinManifest.scopes.map((s) => s.id),
      tokenType: 'Bearer',
      raw: {},
    },
    retry: { maxAttempts: 1 },
    ...extra,
  });
}

const shared = createLinkedInDouble({ totalPosts: 25, orgUrn });

defineConnectorContract(
  { describe, it, expect },
  {
    connector,
    makeCtx: () => ctxFor(shared),
    resource: 'li.posts',
    scenarios: {
      rateLimited: () => ctxFor(createLinkedInDouble({ forceStatus: 429, orgUrn })),
      expiredToken: () => ctxFor(createLinkedInDouble({ forceStatus: 401, orgUrn })),
    },
    // No `webhook` here: like the Keitaro connector, `shared_secret` proves the sender holds a
    // verification token, not body integrity, so the contract suite's universal tamper-rejection
    // check (which mutates the raw body and expects rejection) does not apply. Verified directly
    // below instead. See the comment on `verifyWebhook` in connector.ts.
    fixtures: [
      { kind: KINDS.post, raw: liPost },
      { kind: KINDS.comment, raw: liComment },
      { kind: KINDS.lead, raw: liLead },
    ],
    normalizeCtx: createTestNormalizeCtx(linkedinManifest, { accountExternalId: orgUrn }),
  },
);

describe('LinkedIn connector', () => {
  it('buildAuthUrl points at www.linkedin.com with the real client id, never api.linkedin.com', () => {
    const configured = createLinkedinConnector({
      baseUrl: 'https://api.linkedin.example.test',
      clientId: 'real-linkedin-client',
    });
    const ctx = createTestConnCtx<LinkedinConfig>({
      manifest: linkedinManifest,
      fetch: () => Promise.reject(new Error('unused')),
      config: { baseUrl: 'https://api.linkedin.example.test', clientId: 'real-linkedin-client' },
    });
    const authUrl = configured.buildAuthUrl(ctx, { scopes: MEMBER_ONLY_SCOPES, state: 'state123' });
    const parsed = new URL(authUrl);
    expect(parsed.origin).toBe('https://www.linkedin.com');
    expect(parsed.pathname).toBe('/oauth/v2/authorization');
    expect(parsed.searchParams.get('client_id')).toBe('real-linkedin-client');
  });

  it('discovers approved organizations as accounts', async () => {
    const ctx = ctxFor(shared);
    const accounts = await connector.discoverAccounts(ctx);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      externalId: orgUrn,
      platform: 'LINKEDIN',
      name: 'Acme Corp',
      handle: 'acme-corp',
      accountType: 'organization',
      hasOwnToken: false,
    });
  });

  it('degrades read:posts/read:comments/read:leads when only member-identity scopes are granted', async () => {
    const ctx = ctxFor(shared, {
      token: {
        accessToken: shared.accessToken,
        scopes: MEMBER_ONLY_SCOPES,
        tokenType: 'Bearer',
        raw: {},
      },
    });
    const verification = await connector.verifyScopes(ctx);
    expect(verification.missing).toEqual(
      expect.arrayContaining([
        'r_organization_social',
        'rw_organization_admin',
        'r_marketing_leadgen_automation',
      ]),
    );
    expect(verification.missing).not.toContain('openid');
    expect(verification.missing).not.toContain('profile');
    expect(verification.missing).not.toContain('email');
    expect(verification.degraded.sort()).toEqual(['read:comments', 'read:leads', 'read:posts']);
  });

  it('reports a degraded (not down) health status with an approval remediation when org/Lead-Sync scopes are missing', async () => {
    const ctx = ctxFor(shared, {
      token: {
        accessToken: shared.accessToken,
        scopes: MEMBER_ONLY_SCOPES,
        tokenType: 'Bearer',
        raw: {},
      },
    });
    const report = await connector.health(ctx);
    expect(report.status).toBe('degraded');
    const approval = report.checks.find((c) => c.id === 'approval');
    expect(approval).toMatchObject({
      ok: false,
      remediation:
        'Apply for LinkedIn Marketing Developer Platform access — organization posts, comments and Lead Sync stay unavailable until approved.',
    });
    expect(report.degradedCapabilities.sort()).toEqual([
      'read:comments',
      'read:leads',
      'read:posts',
    ]);
  });

  it('reports health without throwing when fully scoped and reachable', async () => {
    const ctx = ctxFor(shared);
    const report = await connector.health(ctx);
    expect(report.status).toBe('healthy');
    expect(report.checks.find((c) => c.id === 'approval')).toMatchObject({ ok: true });
    expect(report.checks.every((c) => typeof c.ok === 'boolean')).toBe(true);
  });

  it('is entirely read-only: preflight always blocks, execute always throws', async () => {
    const ctx = ctxFor(shared);
    const preflight = await connector.preflight(ctx, {
      id: 'oa_1',
      kind: 'reply_dm',
      payload: {},
      idempotencyKey: 'k',
      requestNonce: 'n',
      requestedByUserId: 'u1',
    });
    expect(preflight).toMatchObject({ ok: false, code: 'POLICY_BLOCKED' });
    await expect(
      connector.execute(ctx, {
        id: 'oa_1',
        kind: 'reply_dm',
        payload: {},
        idempotencyKey: 'k',
        requestNonce: 'n',
        requestedByUserId: 'u1',
      }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('sends the pinned LinkedIn-Version header on outbound requests', async () => {
    const double = createLinkedInDouble({ totalPosts: 3, orgUrn });
    const ctx = ctxFor(double);
    await connector.fetchPage(ctx, { id: 'li.posts', since: null, highWaterMark: null });
    expect(double.requests.length).toBeGreaterThan(0);
    for (const req of double.requests) {
      expect(req.headers['LinkedIn-Version']).toBe(linkedinManifest.apiVersion);
    }
  });

  it('normalizes a lead into a canonical lead with typed fields extracted from form answers', () => {
    const nctx = createTestNormalizeCtx(linkedinManifest, { accountExternalId: orgUrn });
    const [entity] = connector.normalize(KINDS.lead, liLead, nctx);
    expect(entity).toMatchObject({
      kind: 'lead',
      platform: 'LINKEDIN',
      source: 'lead_form',
      formExternalId: 'urn:li:leadForm:555',
      formName: 'Book a demo',
      fullName: 'Jordan Rivera',
      email: 'jordan.rivera@example.com',
      phone: '+14155550123',
      companyName: 'Rivera Consulting',
      campaignExternalId: 'urn:li:sponsoredCampaign:424242',
      consent: { marketing: true },
    });
    expect((entity as { fields: unknown[] }).fields).toHaveLength(5);
  });

  it('verifies the Lead Sync webhook via the shared verification token, and parses the lead id + connection hint', () => {
    const lead = leadFixture(0, { owner: orgUrn });
    const payload = leadWebhookPayload(lead);
    const req = {
      method: 'POST',
      path: '/api/webhooks/linkedin/conn_abc123',
      headers: { 'x-li-verification-token': 'wh-secret' },
      rawBody: JSON.stringify(payload),
      query: {},
    };
    expect(connector.verifyWebhook(req, 'wh-secret')).toBe(true);
    expect(connector.verifyWebhook(req, 'wrong-secret')).toBe(false);
    expect(connector.verifyWebhook({ ...req, headers: {} }, 'wh-secret')).toBe(false);
    const [env] = connector.parseWebhook(req);
    expect(env).toMatchObject({
      kind: KINDS.lead,
      externalId: lead.id,
      connectionHint: {
        platform: 'LINKEDIN',
        connectionId: 'conn_abc123',
        accountExternalId: orgUrn,
      },
    });
  });

  it('normalize is pure and refuses a drifted post shape so core can quarantine it', () => {
    const nctx = createTestNormalizeCtx(linkedinManifest, { accountExternalId: orgUrn });
    const before = structuredClone(liPost);
    const a = connector.normalize(KINDS.post, liPost, nctx);
    const b = connector.normalize(KINDS.post, liPost, nctx);
    expect(b).toEqual(a);
    expect(liPost).toEqual(before);
    expect(() => connector.normalize(KINDS.post, liPostDrift, nctx)).toThrow();
    expect(() => connector.normalize('li_unknown', {}, nctx)).toThrow(NexusError);
  });
});
