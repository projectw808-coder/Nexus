/**
 * The SDK-provided contract test suite (spec §15 "Contract"). Every connector runs it; a
 * connector that passes has proven the guarantees the sync engine relies on:
 *
 *   pagination terminates · cursors resume · idempotency holds under duplicate delivery ·
 *   429 raises RATE_LIMITED · an expired token raises AUTH_EXPIRED · webhook signature
 *   verification rejects tampering · normalize is pure and produces valid canonical entities ·
 *   budget is reserved and settled around every fetch.
 *
 * Framework-agnostic: pass your test runner's `describe` / `it` / `expect`.
 */
import { NexusError } from '@nexus/core';
import { canonicalEntitySchema } from './canonical.ts';
import { connectorManifestSchema } from './manifest.ts';
import {
  rawPageSchema,
  webhookEnvelopeSchema,
  type ConnCtx,
  type Connector,
  type NormalizeCtx,
  type WebhookRequest,
} from './spi.ts';

export type ContractRunner = {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void> | void) => void;
  expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeGreaterThan(n: number): void;
    toBeInstanceOf(c: unknown): void;
  };
};

export type ContractSpec<Cfg> = {
  connector: Connector<Cfg>;
  /** A fresh, healthy context against a platform double that serves at least three pages of `resource`. */
  makeCtx: () => Promise<ConnCtx<Cfg>> | ConnCtx<Cfg>;
  /** Resource id to page through; defaults to the first resource that supports backfill. */
  resource?: string;
  maxPages?: number;
  scenarios: {
    /** A context whose platform answers 429 (with or without Retry-After). */
    rateLimited: () => Promise<ConnCtx<Cfg>> | ConnCtx<Cfg>;
    /** A context whose platform answers 401 / invalid token. */
    expiredToken: () => Promise<ConnCtx<Cfg>> | ConnCtx<Cfg>;
  };
  webhook?: {
    /** A genuine, correctly signed request. */
    valid: WebhookRequest;
    secret: string;
  };
  /** Recorded raw payloads per kind for the purity / validity checks. */
  fixtures: { kind: string; raw: unknown }[];
  normalizeCtx: NormalizeCtx;
};

function deepFreeze(v: unknown): void {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
}

function tamper(req: WebhookRequest): WebhookRequest {
  const body =
    typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : Buffer.from(req.rawBody);
  const copy = Buffer.from(body);
  const i = Math.max(0, copy.length - 2);
  copy[i] = ((copy[i] ?? 0) + 1) % 256;
  return { ...req, rawBody: new Uint8Array(copy) };
}

export function defineConnectorContract<Cfg>(t: ContractRunner, spec: ContractSpec<Cfg>): void {
  const { connector } = spec;
  const manifest = connector.manifest;
  const resourceId =
    spec.resource ??
    manifest.resources.find((r) => r.supportsBackfill)?.id ??
    manifest.resources[0]?.id;
  const maxPages = spec.maxPages ?? 500;

  t.describe(`connector contract: ${manifest.platform}`, () => {
    t.it('manifest is valid and listResources matches it', () => {
      const parsed = connectorManifestSchema.safeParse(manifest);
      t.expect(parsed.success ? null : parsed.error.issues).toBe(null);
      t.expect(connector.listResources().map((r) => r.id)).toEqual(
        manifest.resources.map((r) => r.id),
      );
    });

    t.it('pagination terminates and pages validate', async () => {
      if (!resourceId) throw new Error('connector declares no resources');
      const ctx = await spec.makeCtx();
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await connector.fetchPage(
          ctx,
          { id: resourceId, since: null, highWaterMark: null },
          cursor,
        );
        const parsed = rawPageSchema.safeParse(page);
        t.expect(parsed.success ? null : parsed.error.issues).toBe(null);
        for (const item of page.items) {
          const key = `${item.kind}:${item.externalId}`;
          t.expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
        cursor = page.nextCursor ?? undefined;
        pages += 1;
        if (pages > maxPages)
          throw new Error(`pagination did not terminate within ${maxPages} pages`);
      } while (cursor);
      t.expect(pages).toBeGreaterThan(0);
      t.expect(seen.size).toBeGreaterThan(0);
    });

    t.it('cursors resume: a fresh context continues from a stored cursor', async () => {
      if (!resourceId) return;
      const a = await spec.makeCtx();
      const first = await connector.fetchPage(a, {
        id: resourceId,
        since: null,
        highWaterMark: null,
      });
      if (!first.nextCursor) return; // single page — nothing to resume
      const second = await connector.fetchPage(
        a,
        { id: resourceId, since: null, highWaterMark: null },
        first.nextCursor,
      );
      const b = await spec.makeCtx();
      const resumed = await connector.fetchPage(
        b,
        { id: resourceId, since: null, highWaterMark: null },
        first.nextCursor,
      );
      t.expect(resumed.items.map((i) => i.externalId)).toEqual(
        second.items.map((i) => i.externalId),
      );
      t.expect(typeof first.nextCursor).toBe('string');
    });

    t.it('budget is reserved and settled around a fetch', async () => {
      if (!resourceId) return;
      const ctx = await spec.makeCtx();
      const before = await ctx.budget.snapshot();
      await connector.fetchPage(ctx, { id: resourceId, since: null, highWaterMark: null });
      const after = await ctx.budget.snapshot();
      const usedBefore = before.windows.reduce((s, w) => s + w.used, 0);
      const usedAfter = after.windows.reduce((s, w) => s + w.used, 0);
      t.expect(usedAfter).toBeGreaterThan(usedBefore);
    });

    t.it('429 raises RATE_LIMITED', async () => {
      if (!resourceId) return;
      const ctx = await spec.scenarios.rateLimited();
      let caught: unknown;
      try {
        await connector.fetchPage(ctx, { id: resourceId, since: null, highWaterMark: null });
      } catch (e) {
        caught = e;
      }
      t.expect(caught).toBeInstanceOf(NexusError);
      t.expect((caught as NexusError).code).toBe('RATE_LIMITED');
    });

    t.it('an expired token raises AUTH_EXPIRED', async () => {
      if (!resourceId) return;
      const ctx = await spec.scenarios.expiredToken();
      let caught: unknown;
      try {
        await connector.fetchPage(ctx, { id: resourceId, since: null, highWaterMark: null });
      } catch (e) {
        caught = e;
      }
      t.expect(caught).toBeInstanceOf(NexusError);
      t.expect((caught as NexusError).code).toBe('AUTH_EXPIRED');
    });

    if (spec.webhook) {
      const wh = spec.webhook;
      t.it('webhook verification accepts the genuine request and rejects tampering', () => {
        t.expect(connector.verifyWebhook(wh.valid, wh.secret)).toBe(true);
        t.expect(connector.verifyWebhook(tamper(wh.valid), wh.secret)).toBe(false);
        t.expect(connector.verifyWebhook(wh.valid, `${wh.secret}x`)).toBe(false);
        t.expect(connector.verifyWebhook({ ...wh.valid, headers: {} }, wh.secret)).toBe(false);
      });

      t.it('parseWebhook is idempotent under duplicate delivery', () => {
        const once = connector.parseWebhook(wh.valid);
        const twice = connector.parseWebhook(wh.valid);
        t.expect(twice).toEqual(once);
        for (const env of once) {
          const parsed = webhookEnvelopeSchema.safeParse(env);
          t.expect(parsed.success ? null : parsed.error.issues).toBe(null);
          t.expect(env.connectionHint.platform).toBe(manifest.platform);
        }
      });
    }

    t.it('normalize is pure and yields valid canonical entities', () => {
      for (const fx of spec.fixtures) {
        const raw: unknown = structuredClone(fx.raw);
        deepFreeze(raw);
        const a = connector.normalize(fx.kind, raw, spec.normalizeCtx);
        const b = connector.normalize(fx.kind, raw, spec.normalizeCtx);
        t.expect(b).toEqual(a);
        t.expect(raw).toEqual(fx.raw);
        for (const entity of a) {
          const parsed = canonicalEntitySchema.safeParse(entity);
          t.expect(parsed.success ? null : parsed.error.issues).toBe(null);
          t.expect(entity.platform).toBe(manifest.platform);
        }
      }
    });

    t.it('health never throws and reports a valid status', async () => {
      const ctx = await spec.makeCtx();
      const report = await connector.health(ctx);
      t.expect(['healthy', 'degraded', 'reconnect_required', 'down'].includes(report.status)).toBe(
        true,
      );
      t.expect(Array.isArray(report.checks)).toBe(true);
    });
  });
}
