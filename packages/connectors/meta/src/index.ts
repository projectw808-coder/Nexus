export { createMetaConnector } from './connector.ts';
export type { MetaConfig } from './connector.ts';
export {
  metaManifest,
  META_API_VERSION,
  META_KINDS,
  FB_RESOURCE_IDS,
  IG_RESOURCE_IDS,
} from './manifest.ts';
export type { MetaKind } from './manifest.ts';
export { normalizeMeta, WINDOW_MS } from './normalize.ts';
export { parseMetaWebhook, verifyMetaWebhook } from './webhooks.ts';
export { parseUsageHeaders, classifyGraphError, rethrowGraph } from './graph.ts';
export {
  checkGraphVersion,
  evaluateVersions,
  KNOWN_VERSIONS,
  SUNSET_WARNING_DAYS,
} from './version-monitor.ts';
export type { GraphVersion, VersionCheck } from './version-monitor.ts';
