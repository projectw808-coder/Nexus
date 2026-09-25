/**
 * A scripted double for one customer's Keitaro tracker: just enough surface for the contract
 * suite and this connector's own tests (`conversions/log`, `campaigns`, API-key auth, 401/429
 * scenarios). Not a business-rule simulator — see `@nexus/connector-meta`'s Graph double for
 * the fuller pattern this follows.
 */
import { jsonResponse } from '@nexus/connector-sdk/testing';
import type { FetchLike } from '@nexus/connector-sdk';

export type KeitaroDoubleConversion = Record<string, unknown> & {
  conversion_id: number;
  subid: string;
  tid: string;
  status: string;
  payout: number;
  currency: string;
  postback_datetime: string;
};

function headerLookup(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function conversionFixture(i: number, overrides: Partial<KeitaroDoubleConversion> = {}) {
  const status = i % 5 === 0 ? 'rejected' : i % 3 === 0 ? 'sale' : 'lead';
  return {
    conversion_id: 1000 + i,
    subid: `click_${i}`,
    tid: `tx_${i}`,
    status,
    payout: Number((10 + i).toFixed(2)),
    currency: 'USD',
    campaign: { id: 1, name: 'Spring Promo' },
    source: { id: 2, name: 'push-network' },
    offer: { id: 3, name: 'Weight Loss Offer' },
    affiliate_network: { id: 4, name: 'MaxBounty' },
    stream: { id: 5, name: 'Default flow' },
    landing: { id: 6, name: 'lp-1' },
    country: 'US',
    region: 'CA',
    sub_id_1: `lead-${i}@example.com`,
    click_datetime: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    postback_datetime: new Date(Date.UTC(2026, 8, 1, 1, i)).toISOString(),
    ...overrides,
  } satisfies KeitaroDoubleConversion;
}

export function createKeitaroDouble(
  opts: {
    totalConversions?: number;
    apiKey?: string;
    forceStatus?: 401 | 429;
    conversions?: KeitaroDoubleConversion[];
  } = {},
): {
  fetch: FetchLike;
  conversions: KeitaroDoubleConversion[];
  campaigns: { id: number; name: string; state: string; updated_at: string }[];
  apiKey: string;
} {
  const apiKey = opts.apiKey ?? 'test-api-key';
  const conversions =
    opts.conversions ??
    Array.from({ length: opts.totalConversions ?? 25 }, (_, i) => conversionFixture(i));
  const campaigns = [
    { id: 1, name: 'Spring Promo', state: 'active', updated_at: '2026-09-01T00:00:00.000Z' },
    { id: 2, name: 'Retargeting', state: 'paused', updated_at: '2026-09-05T00:00:00.000Z' },
  ];

  const fetch: FetchLike = async (url, init) => {
    if (opts.forceStatus === 429)
      return jsonResponse(429, { error: 'rate_limited' }, { 'retry-after': '1' });
    if (opts.forceStatus === 401) return jsonResponse(401, { error: 'invalid_api_key' });
    const key = headerLookup(init.headers, 'api-key');
    if (key !== apiKey) return jsonResponse(401, { error: 'invalid_api_key' });

    const u = new URL(url);
    if (u.pathname.endsWith('/campaigns')) {
      const limit = Number(u.searchParams.get('limit') ?? '100');
      const offset = Number(u.searchParams.get('offset') ?? '0');
      return jsonResponse(200, { rows: campaigns.slice(offset, offset + limit) });
    }
    if (u.pathname.endsWith('/conversions/log') && init.method === 'POST') {
      const bodyText = typeof init.body === 'string' ? init.body : '';
      const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      const limit = typeof body.limit === 'number' ? body.limit : 100;
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      let rows = conversions;
      if (typeof body.from === 'string') {
        const since = new Date(body.from);
        rows = rows.filter((c) => new Date(c.postback_datetime) >= since);
      }
      return jsonResponse(200, { rows: rows.slice(offset, offset + limit) });
    }
    return jsonResponse(404, { error: 'not_found' });
  };

  return { fetch, conversions, campaigns, apiKey };
}
