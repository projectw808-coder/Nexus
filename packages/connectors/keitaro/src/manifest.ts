import { connectorManifestSchema, type ConnectorManifest } from '@nexus/connector-sdk';

export const KINDS = {
  conversion: 'keitaro_conversion',
  campaign: 'keitaro_campaign',
  click: 'keitaro_click',
} as const;

/**
 * Keitaro TDS (spec §8.6, ADR-019): a self-hosted tracker, one instance per customer, reached
 * at `ConnectionSettings.baseUrl` (never a shared origin), authenticated with a per-connection
 * API key. No OAuth, no platform-published rate limit, no shared app quota — the `fixed_window`
 * shape here is OUR conservative default limiter (2 req/s, 2 concurrent), not a platform figure;
 * `ConnectionSettings.clientLimiter` overrides it per connection (wired in `bindConnection`).
 */
export const keitaroManifest: ConnectorManifest = connectorManifestSchema.parse({
  platform: 'KEITARO',
  displayName: 'Keitaro',
  apiVersion: 'admin_api/v1',
  docsUrl: 'https://docs.keitaro.io/',
  authKind: 'api_key',
  scopes: [
    {
      id: 'api_key',
      plainLanguage: 'Read campaigns, offers and conversions from your tracker',
      requiredFor: ['read:leads', 'read:insights'],
      sensitive: true,
    },
  ],
  resources: [
    {
      id: 'keitaro.conversions',
      displayName: 'Conversions',
      kinds: [KINDS.conversion],
      defaultIntervalSeconds: 120,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: true,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill', 'webhook'] },
      overlapSeconds: 120,
    },
    {
      id: 'keitaro.campaigns',
      displayName: 'Campaigns, offers & sources',
      kinds: [KINDS.campaign],
      defaultIntervalSeconds: 3600,
      defaultEnabled: true,
      supportsBackfill: true,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta', 'backfill'] },
    },
    {
      id: 'keitaro.clicks',
      displayName: 'Clicks',
      kinds: [KINDS.click],
      defaultIntervalSeconds: 900,
      defaultEnabled: false,
      supportsBackfill: false,
      supportsWebhook: false,
      costPerPage: 1,
      laneHints: { defaultLane: 'delta', allowedLanes: ['delta'] },
      warning:
        'Very high volume — off by default. Only clicks with a conversion sync unless you set a filter; the full click log is never backfilled.',
    },
  ],
  capabilities: ['read:leads', 'read:insights'],
  // A steady-state 2 req/s (§8.6's conservative default) expressed with headroom for a short
  // burst rather than a rigid one-per-second gate, since a real client's requests rarely land
  // on exact one-second boundaries; `ConnectionSettings.clientLimiter` overrides this per
  // connection (wired in `bindConnection`).
  quota: { kind: 'fixed_window', windowSeconds: 5, limit: 10, maxConcurrent: 2 },
  webhooks: {
    supported: true,
    verification: 'shared_secret',
    resources: ['keitaro.conversions'],
    replayable: false,
  },
  constraints: [
    'No published rate limit — the default 2 req/s / 2 concurrent limiter protects a server that is also serving live traffic; raise it per connection only if the tracker can take it.',
    'Clicks are off by default and never fully backfilled; only converted (or explicitly filtered) clicks sync.',
    'Conversions carry no PII by default — map the sub_ids that hold an email, phone or external id in the connection settings, or the click stays an anonymous Identity.',
    'A rejected conversion reverses exactly the revenue its own lead/sale postback added; it never recomputes the Deal amount from scratch.',
  ],
  tierNotes:
    'No tiers or app review: any Keitaro admin can mint an API key under Account → API keys. Requires HTTPS and, self-signed certificates aside, a reachable base URL.',
} satisfies ConnectorManifest);
