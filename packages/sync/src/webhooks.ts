/**
 * Inbound webhooks (§11.3, §9.1): the receiver verifies the signature over the raw bytes,
 * persists the `WebhookEvent`, enqueues processing and acks — no business logic on the ack
 * path. Processing splits the payload into raw items through the same idempotent raw store
 * as polling, so a webhook delivered three times (or a webhook AND a poll of the same object)
 * yields exactly one `ExternalObject` and one normalisation.
 */
import { QUEUES } from '@nexus/config';
import { PLATFORM_LABELS, type Platform, type WebhookRequest } from '@nexus/connector-sdk';
import { NexusError } from '@nexus/core';
import {
  findConnectionForWebhook,
  markWebhookProcessed,
  persistRawItems,
  recordUnroutedWebhookEvent,
  recordWebhookEvent,
  systemActorFor,
} from '@nexus/db';
import { loadConnection } from './context.ts';
import { nowOf, type SyncDeps } from './deps.ts';
import { JOB_NAMES, type IngestRawJob } from './jobs.ts';

export type ReceiveOutcome =
  | { status: 200; eventId: string; routed: true; jobId: string }
  | { status: 200; eventId: string; routed: false; reason: 'no_connection' | 'ping' }
  | { status: 401; eventId: string; reason: 'unverified'; remediation: string }
  | { status: 404; reason: 'unknown_platform' | 'unroutable' };

function pathConnectionId(req: WebhookRequest): string | undefined {
  const m = /\/webhooks\/[a-z_]+\/([A-Za-z0-9_-]{8,})/i.exec(req.path);
  return m?.[1];
}

/** Runs the failure taxonomy (§9.2) instead of a bare literal, so a rejection always carries
 * the same typed `remediation` string every other failure path in the product does. */
function unverifiedWebhookError(platform: Platform, hadSecretToTry: boolean): NexusError {
  const label = PLATFORM_LABELS[platform] ?? platform;
  return new NexusError('VALIDATION', {
    context: {
      reason: `${label} webhook signature could not be verified.`,
      detail: hadSecretToTry
        ? `Confirm the webhook secret configured for this connection matches what ${label} is signing with, or reconnect ${label} to mint a new one.`
        : `No webhook secret is on file for this connection yet — reconnect ${label} to mint one.`,
    },
  });
}

function bodyJson(req: WebhookRequest): unknown {
  const text =
    typeof req.rawBody === 'string' ? req.rawBody : Buffer.from(req.rawBody).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 10_000) };
  }
}

/** The ack path. Must stay well under 200 ms: one vault read at most, one insert, one enqueue. */
export async function receiveWebhook(
  deps: SyncDeps,
  platform: Platform,
  req: WebhookRequest,
): Promise<ReceiveOutcome> {
  const connector = deps.registry.tryGet(platform);
  if (!connector) return { status: 404, reason: 'unknown_platform' };

  // Secret resolution: a connection id in the path selects that connection's secret (vault);
  // otherwise the platform's app-level secret (Meta's app secret) verifies every event.
  const connId = pathConnectionId(req);
  let secret: string | null = null;
  let routed: { id: string; workspaceId: string } | null = null;
  if (connId) {
    const c = await findConnectionForWebhook(deps.runtime, { platform, connectionId: connId });
    if (c) {
      routed = { id: c.id, workspaceId: c.workspaceId };
      if (c.webhookSecretRef) {
        secret = await deps.runtime
          .withTenant(systemActorFor(c.workspaceId, c.id), (db) =>
            deps.vault.get(db, c.webhookSecretRef!),
          )
          .then((r) => r.secret)
          .catch(() => null);
      }
    }
  }
  // Both are legitimate authorities: Keitaro-style platforms sign with the per-connection secret,
  // Meta-style platforms with the app secret. Try the connection's first, then the app's.
  const candidates = [secret, deps.appSecrets.webhookSecret(platform)].filter((s): s is string =>
    Boolean(s),
  );
  const verified = candidates.some((s) => connector.verifyWebhook(req, s));
  const headers = Object.fromEntries(Object.entries(req.headers));
  if (!verified) {
    const err = unverifiedWebhookError(platform, candidates.length > 0);
    const ev = await recordUnroutedWebhookEvent(deps.runtime, {
      workspaceId: routed?.workspaceId ?? null,
      connectionId: routed?.id ?? null,
      platform,
      headers,
      body: bodyJson(req),
      verified: false,
      remediation: err.remediation,
    });
    deps.logger.warn('rejected unverified webhook', {
      platform,
      eventId: ev.id,
      connectionId: routed?.id ?? null,
    });
    return { status: 401, eventId: ev.id, reason: 'unverified', remediation: err.remediation };
  }

  if (!routed) {
    const envelopes = connector.parseWebhook(req);
    const hint = envelopes[0]?.connectionHint;
    if (!hint) {
      const ev = await recordUnroutedWebhookEvent(deps.runtime, {
        workspaceId: null,
        connectionId: null,
        platform,
        headers,
        body: bodyJson(req),
        verified: true,
      });
      return { status: 200, eventId: ev.id, routed: false, reason: 'ping' };
    }
    const c = await findConnectionForWebhook(deps.runtime, {
      platform,
      connectionId: hint.connectionId,
      accountExternalId: hint.accountExternalId,
    });
    if (!c) {
      const ev = await recordUnroutedWebhookEvent(deps.runtime, {
        workspaceId: null,
        connectionId: null,
        platform,
        headers,
        body: bodyJson(req),
        verified: true,
      });
      deps.logger.warn('verified webhook for an unknown connection', {
        platform,
        eventId: ev.id,
        hint,
      });
      return { status: 200, eventId: ev.id, routed: false, reason: 'no_connection' };
    }
    routed = { id: c.id, workspaceId: c.workspaceId };
  }

  const target = routed;
  const actor = systemActorFor(target.workspaceId, target.id);
  const ev = await deps.runtime.withTenant(actor, (db) =>
    recordWebhookEvent(db, {
      workspaceId: target.workspaceId,
      connectionId: target.id,
      platform,
      headers,
      body: bodyJson(req),
      verified: true,
      receivedAt: nowOf(deps),
    }),
  );
  const job = await deps.bus.enqueue({
    queue: QUEUES.ingestRaw,
    name: JOB_NAMES.ingestWebhook,
    data: {
      workspaceId: routed.workspaceId,
      connectionId: routed.id,
      eventId: ev.id,
    } satisfies IngestRawJob,
    opts: { jobId: `webhook-${ev.id}`, lane: 'webhook' },
  });
  return { status: 200, eventId: ev.id, routed: true, jobId: job.jobId };
}

/** Off the ack path: split the stored payload into raw items, persist idempotently, queue normalisation. */
export async function processWebhookEvent(
  deps: SyncDeps,
  input: IngestRawJob,
): Promise<{ items: number; created: number; updated: number; skipped: number }> {
  const connection = await loadConnection(deps, input.workspaceId, input.connectionId);
  const connector = deps.registry.get(connection.platform);
  const actor = systemActorFor(connection.workspaceId, connection.id);
  const event = await deps.runtime.withTenant(actor, (db) =>
    db.webhookEvent.findUnique({ where: { id: input.eventId } }),
  );
  if (!event || !event.verified)
    throw new Error(`webhook event ${input.eventId} missing or unverified`);
  if (event.processedAt) return { items: 0, created: 0, updated: 0, skipped: 0 };

  const bodyText = JSON.stringify(event.body);
  const req: WebhookRequest = {
    method: 'POST',
    path: `/api/webhooks/${connection.platform.toLowerCase()}/${connection.id}`,
    headers: (event.headers ?? {}) as Record<string, string>,
    rawBody: bodyText,
    query: {},
  };
  try {
    const envelopes = connector.parseWebhook(req);
    const res = await deps.runtime.withTenant(actor, (db) =>
      persistRawItems(db, {
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        platform: connection.platform,
        apiVersion: connection.settings.apiVersion ?? connection.apiVersion,
        items: envelopes.map((e) => ({
          kind: e.kind,
          externalId: e.externalId,
          parentExternalId: e.parentExternalId,
          raw: e.raw,
        })),
        fetchedAt: event.receivedAt,
      }),
    );
    const toNormalize = [...res.created, ...res.updated];
    if (toNormalize.length) {
      await deps.bus.enqueue({
        queue: QUEUES.normalize,
        name: JOB_NAMES.normalize,
        data: {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          objectIds: toNormalize,
        },
        opts: { lane: 'webhook' },
      });
    }
    await deps.runtime.withTenant(actor, (db) => markWebhookProcessed(db, event.id, {}));
    return {
      items: envelopes.length,
      created: res.created.length,
      updated: res.updated.length,
      skipped: res.skipped,
    };
  } catch (e) {
    await deps.runtime.withTenant(actor, (db) =>
      markWebhookProcessed(db, event.id, { error: e instanceof Error ? e.message : String(e) }),
    );
    throw e;
  }
}
