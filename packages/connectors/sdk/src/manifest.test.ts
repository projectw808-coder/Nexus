import { describe, expect, it } from 'vitest';
import { connectorManifestSchema, type ConnectorManifest } from './manifest.ts';

const validManifest: ConnectorManifest = {
  platform: 'MOCK',
  displayName: 'Mock platform',
  apiVersion: 'v1',
  docsUrl: 'https://example.com/docs/mock',
  authKind: 'oauth2_pkce',
  scopes: [
    {
      id: 'mock.read',
      plainLanguage: 'Read your posts and messages',
      requiredFor: ['read:posts', 'read:messages'],
      sensitive: false,
    },
    {
      id: 'mock.write',
      plainLanguage: 'Reply to messages on your behalf',
      requiredFor: ['write:reply_dm'],
      sensitive: true,
    },
  ],
  resources: [
    {
      id: 'mock.messages',
      displayName: 'Messages',
      kinds: ['mock_message'],
      defaultIntervalSeconds: 60,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: {
        defaultLane: 'delta',
        allowedLanes: ['interactive', 'webhook', 'delta', 'backfill'],
      },
    },
  ],
  capabilities: ['read:posts', 'read:messages', 'write:reply_dm'],
  quota: { kind: 'fixed_window', windowSeconds: 900, limit: 300 },
  webhooks: {
    supported: true,
    verification: 'hmac_sha256',
    resources: ['mock.messages'],
    replayable: false,
  },
  constraints: ['Mock only.'],
  tierNotes: 'None.',
};

describe('connectorManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const result = connectorManifestSchema.safeParse(validManifest);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('rejects a scope whose requiredFor names an unknown capability', () => {
    const bad = {
      ...validManifest,
      scopes: [
        { id: 'mock.x', plainLanguage: 'x', requiredFor: ['read:everything'], sensitive: false },
      ],
    };
    const result = connectorManifestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.join('.') === 'scopes.0.requiredFor.0')).toBe(
      true,
    );
  });

  it('rejects a scope required for a capability the manifest does not declare', () => {
    const bad: ConnectorManifest = {
      ...validManifest,
      scopes: [
        { id: 'mock.leads', plainLanguage: 'leads', requiredFor: ['read:leads'], sensitive: false },
      ],
    };
    expect(connectorManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a webhook resource that is not a declared resource', () => {
    const bad: ConnectorManifest = {
      ...validManifest,
      webhooks: { ...validManifest.webhooks, resources: ['mock.ghost'] },
    };
    expect(connectorManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed resource ids and duplicate resources', () => {
    const [res] = validManifest.resources;
    if (!res) throw new Error('fixture has a resource');
    expect(
      connectorManifestSchema.safeParse({
        ...validManifest,
        resources: [{ ...res, id: 'Messages' }],
      }).success,
    ).toBe(false);
    expect(
      connectorManifestSchema.safeParse({ ...validManifest, resources: [res, res] }).success,
    ).toBe(false);
  });
});
