/**
 * Queue names (spec §4). One place, so producers and processors cannot drift.
 * Lanes (interactive > webhook > delta > backfill) are defined next to the quota model in
 * `@nexus/connector-sdk` and mapped to BullMQ priorities there (ADR-005).
 */
export const QUEUES = {
  syncBackfill: 'sync.backfill',
  syncDelta: 'sync.delta',
  ingestRaw: 'ingest.raw',
  normalize: 'normalize',
  resolve: 'resolve',
  automate: 'automate',
  aiEnrich: 'ai.enrich',
  outbound: 'outbound',
  /** Customer-facing outbound webhooks (§11.2, Phase 11): one signed HTTP POST per delivery. */
  outboundWebhook: 'outbound.webhook',
  /** Housekeeping and diagnostics: token refresh, purge, drift samples, the trace ping. */
  system: 'system',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Prefix for every BullMQ key so a shared Redis can also hold the rate-budget store. */
export const QUEUE_PREFIX = 'nexus';
