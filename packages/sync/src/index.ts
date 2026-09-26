/**
 * @nexus/sync — the sync engine (spec §4.1, §9). Stages 1–3 of the pipeline with the sink
 * seam for 4–7, webhook intake, replay, the dead-letter policy, the token sweep and the poll
 * planner. Hosted by apps/worker; also used inline by the web tier and the CLI.
 */
export { createInlineBus } from './bus.ts';
export type {
  JobBus,
  JobEnvelope,
  JobOptions,
  ActiveJob,
  JobHandler,
  DeadLetterHook,
  InlineBus,
  InlineBusOptions,
} from './bus.ts';
export { createConnectorRegistry } from './registry.ts';
export type { ConnectorRegistry, RegistryOptions } from './registry.ts';
export type { SyncDeps, AppSecrets } from './deps.ts';
export { countingSink } from './sink.ts';
export { createConversationSink, composeSinks } from './sinks/conversations.ts';
export type { ConversationSinkStats } from './sinks/conversations.ts';
export { createTimelineSink } from './sinks/timeline.ts';
export type { TimelineSinkStats } from './sinks/timeline.ts';
export { createIdentitySink, actorExternalIds } from './sinks/identity.ts';
export type { IdentitySinkStats } from './sinks/identity.ts';
export { runIdentityRescore } from './identity-rescore.ts';
export type { RescoreResult } from './identity-rescore.ts';
export { requestReply, executeOutbound, idempotencyKeyFor, OUTBOUND_JOB } from './outbound.ts';
export type { ReplyRequest, ReplyOutcome, OutboundJob } from './outbound.ts';
export { runMetaVersionMonitor } from './version-monitor.ts';
export type { VersionMonitorResult } from './version-monitor.ts';
export type { CanonicalSink, NormalizedBatch } from './sink.ts';
export { bindConnection, loadConnection } from './context.ts';
export type { Bound } from './context.ts';
export { applyFailure, asNexusError } from './failures.ts';
export {
  handleJob,
  deadLetterJob,
  syncJobSchema,
  normalizeJobSchema,
  ingestRawJobSchema,
  outboundJobSchema,
  JOB_NAMES,
  syncJobId,
} from './jobs.ts';
export type { SyncJob, NormalizeJob, IngestRawJob, OutboundJobData } from './jobs.ts';
export { runResourceSync } from './stages/acquire.ts';
export type { SyncOutcome } from './stages/acquire.ts';
export { normalizeObjects, requeuePendingNormalization } from './stages/normalize.ts';
export type { NormalizeOutcome } from './stages/normalize.ts';
export { enqueueAutomationEventsForObjects, AUTOMATE_JOB } from './react.ts';
// ── Phase 11: customer-facing outbound webhooks (§11.2, ADR-022 decision 4) ──
export {
  OUTBOUND_WEBHOOK_JOB,
  PUBLIC_EVENT_FOR_TRIGGER,
  outboundWebhookJobSchema,
  publicEventFor,
  outboundWebhookData,
  outboundWebhookEnqueue,
  enqueueOutboundWebhookDelivery,
  dispatchOutboundWebhooks,
  dispatchOutboundWebhooksForEvent,
  deliverOutboundWebhookJob,
  resumeDueOutboundWebhookDeliveries,
} from './outbound-webhooks.ts';
export type { OutboundWebhookJobData, OutboundWebhookTriggerEvent } from './outbound-webhooks.ts';
export { receiveWebhook, processWebhookEvent } from './webhooks.ts';
export type { ReceiveOutcome } from './webhooks.ts';
export { replayConnection, replayDeadLetter } from './replay.ts';
export type { ReplayStage } from './replay.ts';
export { planDeltaPolls, enqueueBackfill, enqueueDelta, resourcesFor } from './scheduler.ts';
export type { PlannedPoll } from './scheduler.ts';
export { sweepTokens, loggingNotifier, mailNotifier } from './token-refresh.ts';
export type { Notifier, SweepResult } from './token-refresh.ts';
export {
  connectPlatform,
  connectApiKeyPlatform,
  startOauth,
  completeOauth,
  buildAuthCtx,
} from './connect.ts';
export type { ConnectApiKeyResult } from './connect.ts';
export type { ConnectResult } from './connect.ts';
export {
  createSyncDeps,
  keyProviderFromEnv,
  appSecretsFromEnv,
  sdkLoggerFrom,
} from './env-deps.ts';
export type { CreateDepsOptions } from './env-deps.ts';
export type { OauthStart, OauthComplete } from './connect.ts';
