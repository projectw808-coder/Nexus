import { z } from 'zod';
import type { FailureClass, Result } from '@nexus/core';
import type { Capability } from './capability.ts';
import type { CanonicalEntity } from './canonical.ts';
import type { ConnectorManifest, ResourceDescriptor } from './manifest.ts';
import { platformSchema, type Platform } from './platform.ts';
import type { BudgetSnapshot, Lane } from './quota.ts';
import type { ConnectionSettings } from './settings.ts';

export type { Result, FailureClass } from '@nexus/core';

// ─── Auth ───────────────────────────────────────────────────────────────────

/**
 * Resolved app-level credentials for a platform (the Nexus app registration,
 * not the customer's token). Obtained ONLY through `AuthCtx.appCredentials()`
 * at the moment of use, never stored on the ctx object, never logged.
 */
export interface AppCredentials {
  clientId: string;
  /** Absent for PKCE-only / public clients and for api_key platforms. */
  clientSecret?: string;
  /** OAuth 1.0a consumer key/secret pairs use `clientId`/`clientSecret`; anything else lands here. */
  extra?: Readonly<Record<string, string>>;
}

/** PKCE verifier/challenge pair minted by core for `oauth2_pkce` connectors. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export const tokenSetSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.coerce.date().optional(),
  /** Scopes the platform reports as granted (may differ from what was requested). */
  scopes: z.array(z.string()),
  tokenType: z.string().default('Bearer'),
  /** The platform's token response, verbatim, for fields we do not model. Encrypted with the rest. */
  raw: z.unknown(),
});

/**
 * A credential as handed to and from the `TokenVault`. For `api_key`
 * platforms (Keitaro) `accessToken` IS the key and `refreshToken` is absent.
 */
export type TokenSet = z.infer<typeof tokenSetSchema>;

/**
 * Context for the auth methods, which run BEFORE a `Connection` exists (or when
 * re-authorizing one). Holds no secrets inline: `appCredentials()` resolves
 * them through the vault at call time so a logged ctx leaks nothing.
 */
export interface AuthCtx<Cfg = unknown> {
  workspaceId: string;
  /** Set when re-authorizing or refreshing an existing connection. */
  connectionId?: string;
  /** The callback URL registered with the platform for this deployment. */
  redirectUri: string;
  appCredentials: () => Promise<AppCredentials>;
  /** Connector-specific static configuration (e.g. TikTok provider selection, Keitaro base URL). */
  config: Cfg;
  /** Core-injected client for the token endpoints (same retries, breaker and tracing as data calls). */
  http: HttpClient;
  logger: Logger;
  signal: AbortSignal;
}

// ─── Connection context ─────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Objects are JSON-encoded; strings/bytes are sent verbatim. */
  body?: unknown;
  timeoutMs?: number;
  /**
   * Endpoint id for the circuit breaker and budget windows (defaults to `METHOD /path`). Use the
   * same ids as the manifest quota tables so observed usage lands on the right window.
   */
  endpoint?: string;
  /** Per-request cancellation, combined with the ctx signal. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. Usage headers here feed `BudgetHandle.settle`. */
  headers: Readonly<Record<string, string>>;
  bodyText: string;
  /** Parses `bodyText` as JSON; throws on non-JSON. */
  json(): unknown;
  /** How many HTTP attempts the client made (retries on 5xx/408/transport faults). */
  attempts?: number;
}

/**
 * The only way a connector may talk to a platform. Core injects it so that
 * retries, the circuit breaker, TLS pinning (Keitaro), tracing and the
 * `SCHEMA_DRIFT` served-version assertion happen in one place.
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Usage figures parsed from a platform response, trusted over the manifest. */
export interface ObservedUsage {
  remaining?: number;
  limit?: number;
  resetsAt?: Date;
  retryAfter?: Date;
  /** Meta `X-App-Usage`-style percentage (0–100). */
  percentUsed?: number;
  /** The raw usage headers, for the audit trail. */
  headers?: Readonly<Record<string, string>>;
}

export interface BudgetReservation {
  id: string;
  connectionId: string;
  endpoint: string;
  lane: Lane;
  reservedCost: number;
  reservedAt: Date;
  /** Carried from `ReserveRequest.resourceKey` so settle can record the dedup ledger entry. */
  resourceKey?: string;
}

export interface ReserveRequest {
  /** Endpoint id as declared in the manifest's quota tables. */
  endpoint: string;
  /** Expected cost in the connection's quota units (calls, YouTube units, credits). */
  cost: number;
  /**
   * For `metered_credits`: the platform resource being read, so the 24h dedup
   * ledger can skip the charge on a re-read within the window.
   */
  resourceKey?: string;
}

export interface SettleOutcome {
  /** Actual cost when it differs from the reservation (e.g. dedup hit → 0). */
  actualCost?: number;
  observed?: ObservedUsage;
  httpStatus?: number;
}

/**
 * Reserve-before-call, settle-after (§7.3). `reserve()` fails with
 * `RATE_LIMITED` or `QUOTA_EXHAUSTED` when the lane cannot be served right now;
 * a connector must NOT make the call in that case. `settle()` must be called
 * exactly once per successful reservation, even when the call failed.
 */
export interface BudgetHandle {
  reserve(req: ReserveRequest): Promise<Result<BudgetReservation>>;
  settle(reservation: BudgetReservation, outcome: SettleOutcome): Promise<void>;
  snapshot(): Promise<BudgetSnapshot>;
}

/**
 * Everything a connector gets for a call against an existing `Connection`.
 * Tokens are resolved lazily via `token()` so ctx objects can be logged and
 * serialized safely; the returned `TokenSet` must never be persisted or logged
 * by the connector.
 */
export interface ConnCtx<Cfg = unknown> {
  workspaceId: string;
  connectionId: string;
  platform: Platform;
  /** The pinned version for THIS connection (may lag the manifest during a migration). */
  apiVersion: string;
  /** The connected account (Page id, IG user id, channel id, tracker host). */
  accountExternalId: string;
  settings: ConnectionSettings;
  config: Cfg;
  token: () => Promise<TokenSet>;
  /**
   * The per-connection webhook verify secret (§5.4), for connectors that register it with the
   * platform on `subscribeWebhooks`. Resolved from the vault at call time; `null` before a
   * connection exists or on platforms that sign with an app-level secret.
   */
  webhookSecret: () => Promise<string | null>;
  budget: BudgetHandle;
  http: HttpClient;
  logger: Logger;
  /** Aborted on worker shutdown, job timeout or user pause; long loops must check it. */
  signal: AbortSignal;
  lane: Lane;
}

/**
 * Context for the PURE normalize step. Carries only data; no accessors, no I/O.
 */
export interface NormalizeCtx {
  connectionId: string;
  workspaceId: string;
  platform: Platform;
  /** The account the data was fetched as — needed to derive `direction` on messages. */
  accountExternalId: string;
  /** API version the raw payload was fetched under (from `ExternalObject.apiVersion`). */
  apiVersion: string;
  fetchedAt: Date;
  /**
   * Field-mapping hints resolved from the connection's `FieldMapping` (§6.3):
   * source path → attribute id. The connector uses them only to populate
   * `_unmapped`-avoiding typed fields; materialization applies the real rules.
   */
  fieldMapping: Readonly<Record<string, string>>;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

export const discoveredAccountSchema = z.object({
  /** Stable platform id (Page id, IG business account id, LI organization URN, YT channel id). */
  externalId: z.string().min(1),
  /** The `Platform` this sub-account becomes a `Connection` for (a Facebook login yields FACEBOOK and INSTAGRAM rows). */
  platform: platformSchema,
  name: z.string().min(1),
  handle: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  /** Kind as the platform calls it: `page`, `instagram_business_account`, `organization`, `channel`. */
  accountType: z.string().min(1),
  /** Whether the connector obtained an account-scoped token (Meta Page tokens) — core stores it as its own vault entry. */
  hasOwnToken: z.boolean(),
  /** Parent account when nested (IG account → linked Page). */
  parentExternalId: z.string().nullable(),
  raw: z.unknown(),
});

export type DiscoveredAccount = z.infer<typeof discoveredAccountSchema>;

export interface ScopeVerification {
  /** Scope ids from the manifest that the platform reports as NOT granted. */
  missing: string[];
  /** Capabilities unusable as a result; core disables just these. */
  degraded: Capability[];
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

export const resourceRefSchema = z.object({
  /** `ResourceDescriptor.id`. */
  id: z.string().min(1),
  /** Backfill lower bound (`now - backfillDays`); `null` for a delta poll. */
  since: z.coerce.date().nullable(),
  /** Delta polls pass the previous `highWaterMark` minus `overlapSeconds`. */
  highWaterMark: z.coerce.date().nullable(),
  /** Requested page size; the connector clamps to the platform maximum. */
  pageSize: z.number().int().positive().optional(),
});

export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const rawItemSchema = z.object({
  /** `ExternalObject.kind`, e.g. `ig_comment`, `x_dm`, `keitaro_conversion`. */
  kind: z.string().min(1),
  externalId: z.string().min(1),
  parentExternalId: z.string().optional(),
  raw: z.unknown(),
  /** Best-effort platform timestamp; lets core advance the high-water mark without normalizing. */
  occurredAt: z.coerce.date().optional(),
});

export type RawItem = z.infer<typeof rawItemSchema>;

export const rawPageSchema = z.object({
  items: z.array(rawItemSchema),
  /** Opaque, connector-defined; `null` = no more pages. Persisted verbatim to `SyncCursor.cursor`. */
  nextCursor: z.string().nullable(),
  /** Actual budget consumed, after settling against observed headers. */
  budgetSpent: z.number().nonnegative(),
  /** Newest `occurredAt` in this page; core stores it on the cursor for overlap re-queries. */
  highWaterMark: z.coerce.date().optional(),
  /** The API version the platform actually served, when it reports one — core compares with the pinned version. */
  servedApiVersion: z.string().optional(),
});

export type RawPage = z.infer<typeof rawPageSchema>;

/** The inbound HTTP request as received by `POST /api/webhooks/:platform/...`, untouched. */
export interface WebhookRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Readonly<Record<string, string>>;
  /** Raw bytes (a Node `Buffer` is a `Uint8Array`) — signatures are computed over these, never over a re-serialized body. */
  rawBody: Uint8Array | string;
  query: Readonly<Record<string, string>>;
}

export const webhookEnvelopeSchema = z.object({
  kind: z.string().min(1),
  externalId: z.string().min(1),
  parentExternalId: z.string().optional(),
  raw: z.unknown(),
  receivedAt: z.coerce.date(),
  /**
   * How core finds the `Connection` this belongs to. Platforms rarely send
   * our connection id, so the connector extracts whatever it can: the Page id,
   * the channel id, or the id embedded in the webhook path (Keitaro).
   */
  connectionHint: z.object({
    platform: platformSchema,
    connectionId: z.string().optional(),
    accountExternalId: z.string().optional(),
  }),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

// ─── Outbound ───────────────────────────────────────────────────────────────

export const outboundActionKindSchema = z.enum([
  'reply_dm',
  'send_dm',
  'reply_comment',
  'publish_post',
  'hide_comment',
  'unhide_comment',
  'delete_comment',
  'react',
  'follow',
  'unfollow',
  'reply_review',
]);
export type OutboundActionKind = z.infer<typeof outboundActionKindSchema>;

export const outboundActionInputSchema = z.object({
  /** The `OutboundAction.id` row, for correlation in logs and the audit trail. */
  id: z.string().min(1),
  kind: outboundActionKindSchema,
  conversationExternalId: z.string().optional(),
  /** Reply target (comment id, post id, review id) when the kind needs one. */
  targetExternalId: z.string().optional(),
  /** Kind-specific body: `{ text, attachments? }` for messages, `{ text, media? }` for posts, `{ reactionType }` for react. */
  payload: z.unknown(),
  /** `hash(connectionId, kind, conversationId, contentHash, requestNonce)` — content PLUS nonce (§6.4). */
  idempotencyKey: z.string().min(1),
  /** Minted client-side per user intent; replayed on retry so a double-submit collapses to one send. */
  requestNonce: z.string().min(1),
  requestedByUserId: z.string().min(1),
});

export type OutboundActionInput = z.infer<typeof outboundActionInputSchema>;
/** Alias so the SPI reads exactly as spec §7.1. */
export type OutboundAction = OutboundActionInput;

export const outboundResultSchema = z.object({
  /** The platform id of the created object; persisted to `OutboundAction.externalId`. */
  externalId: z.string().min(1),
  sentAt: z.coerce.date(),
  raw: z.unknown(),
});

export type OutboundResult = z.infer<typeof outboundResultSchema>;

/**
 * Answer to "can we legally/technically send right now?". A `false` result
 * never reaches the queue; its `remediation` is rendered inline in the
 * composer before the user types (§9.2 `POLICY_BLOCKED`).
 */
export type Preflight =
  | { ok: true; warnings: string[] }
  | { ok: false; code: FailureClass; reason: string; remediation: string; retryAfter?: Date };

// ─── Health ─────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'reconnect_required' | 'down';

export interface HealthCheck {
  /** `token`, `scopes`, `api_version`, `webhook_subscription`, `budget`, `reachability`… */
  id: string;
  ok: boolean;
  detail?: string;
  failureClass?: FailureClass;
  remediation?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: HealthCheck[];
  tokenExpiresAt: Date | null;
  degradedCapabilities: Capability[];
  lastError: { code: FailureClass; message: string; at: Date } | null;
  checkedAt: Date;
}

// ─── The SPI (spec §7.1) ────────────────────────────────────────────────────

/**
 * A platform connector. Everything the core knows about a platform comes
 * through this interface; core code never imports a platform package
 * directly. `Cfg` is the connector's static configuration bag.
 *
 * Implementations are stateless: every method receives its context, and any
 * caching goes through core-provided stores. Errors are thrown as `NexusError`
 * with a `FailureClass` so the §9.2 taxonomy can drive behaviour and UI.
 */
export interface Connector<Cfg = unknown> {
  readonly manifest: ConnectorManifest;

  // ── auth ───────────────────────────────────────────────────────────────

  /**
   * Build the platform authorization URL. Pure. `state` is core's CSRF token
   * and must be forwarded verbatim; `pkce` is present for `oauth2_pkce`
   * connectors and its `challenge` (never the verifier) goes into the URL.
   * `api_key` connectors do not implement a redirect flow and should throw
   * `VALIDATION`.
   */
  buildAuthUrl(
    ctx: AuthCtx<Cfg>,
    opts: { scopes: string[]; state: string; pkce?: PkcePair },
  ): string;

  /**
   * Exchange the authorization code (plus PKCE verifier) for a `TokenSet`.
   * For Meta this includes the long-lived token exchange. The returned set is
   * handed straight to the vault; do not log it. Throw `AUTH_EXPIRED` on
   * `invalid_grant`.
   */
  exchangeCode(ctx: AuthCtx<Cfg>, code: string, verifier?: string): Promise<TokenSet>;

  /**
   * Refresh a token set. Core calls this at 70% of remaining lifetime (§5.4).
   * Return a complete new `TokenSet` (carry the old refresh token forward when
   * the platform does not rotate it). Platforms with no refresh path (Keitaro
   * api keys) throw `AUTH_EXPIRED` with the remediation to regenerate the key.
   */
  refresh(ctx: AuthCtx<Cfg>, token: TokenSet): Promise<TokenSet>;

  /**
   * Revoke the token at the platform on "disconnect & purge". Best-effort:
   * a platform-side failure is logged, not surfaced, because the vault entry
   * is deleted regardless.
   */
  revoke(ctx: AuthCtx<Cfg>, token: TokenSet): Promise<void>;

  /**
   * After OAuth: list the sub-accounts (Pages, IG accounts, LI organizations,
   * YT channels) the user may attach. Each becomes its own `Connection` row.
   * Called with a provisional `ConnCtx` whose `accountExternalId` is the
   * authorizing user's id.
   */
  discoverAccounts(ctx: ConnCtx<Cfg>): Promise<DiscoveredAccount[]>;

  /**
   * Compare granted scopes against the manifest. Core stores `missing` on
   * `Connection.scopesGranted` / `scopesRequired` and disables `degraded`
   * capabilities individually (a `SCOPE_MISSING` never pauses the connection).
   */
  verifyScopes(ctx: ConnCtx<Cfg>): Promise<ScopeVerification>;

  // ── ingest ─────────────────────────────────────────────────────────────

  /** What this connector can sync — normally `manifest.resources`. Pure. */
  listResources(): ResourceDescriptor[];

  /**
   * Fetch one page of a resource. Contract:
   * - `budget.reserve()` BEFORE the HTTP call, `budget.settle()` after, with observed headers.
   * - Return items raw; no interpretation, no dropping unknown shapes.
   * - `nextCursor` is opaque to core and must survive a worker restart (stringly, no closures).
   * - Respect `ctx.signal`; a cancelled fetch throws, it does not return a partial page.
   * - Throw a `NexusError` with the right `FailureClass` (`RATE_LIMITED` on 429 with `retryAfter`,
   *   `PLATFORM_DOWN` on 5xx, `AUTH_EXPIRED` on 401, `SCOPE_MISSING` on 403 insufficient scope).
   */
  fetchPage(ctx: ConnCtx<Cfg>, r: ResourceRef, cursor?: string): Promise<RawPage>;

  /**
   * Verify the webhook signature over the RAW body bytes. Pure and synchronous
   * — it sits in the < 200 ms ack path. `false` → core replies 401 and logs a
   * `WebhookEvent` with `verified: false`; nothing unverified is ever parsed.
   * Meta: `X-Hub-Signature-256` HMAC with the app secret. Keitaro: the
   * per-connection shared secret in the path or header.
   */
  verifyWebhook(req: WebhookRequest, secret: string): boolean;

  /**
   * Split a verified webhook body into `ExternalObject`-shaped envelopes with
   * NO interpretation — that is `normalize()`'s job, later, off the ack path.
   * Pure and synchronous. Handshake/verification pings return `[]`.
   */
  parseWebhook(req: WebhookRequest): WebhookEnvelope[];

  /**
   * (Re)subscribe the platform's push for the given resource ids. Idempotent:
   * calling it twice must not create duplicate subscriptions. Webhooks are
   * hints; core keeps the reconciliation poll regardless (§9.1).
   */
  subscribeWebhooks(ctx: ConnCtx<Cfg>, resources: string[]): Promise<void>;

  // ── normalize (PURE — no I/O, unit-tested against fixtures) ────────────

  /**
   * Turn one raw payload into zero or more canonical entities. MUST be a pure
   * function of `(kind, raw, ctx)`: no I/O, no clock, no randomness, no
   * mutation of `raw`. One raw object may yield several entities (a comment
   * yields a `message` and a `person`). Throw on shapes you do not understand
   * so core can quarantine the object as `SCHEMA_DRIFT` — never guess, and
   * never swallow. Output is validated against `canonicalEntitySchema` in
   * dev/test and sampled in prod.
   */
  normalize(kind: string, raw: unknown, ctx: NormalizeCtx): CanonicalEntity[];

  // ── outbound ───────────────────────────────────────────────────────────

  /**
   * Capabilities usable RIGHT NOW on this connection: the manifest set minus
   * whatever `verifyScopes` degraded and whatever the customer's tier or
   * approval state withholds (LinkedIn "not yet approved", TikTok provider
   * matrix).
   */
  capabilities(ctx: ConnCtx<Cfg>): Promise<Capability[]>;

  /**
   * Perform the write. Called only after `preflight()` passed and the action
   * was enqueued. Must be idempotent on `idempotencyKey`: if the platform
   * offers an idempotency mechanism use it; otherwise look the key up in
   * `raw` of recent outbound results before sending. Honour `settings.dryRun`
   * by returning a synthetic result without touching the platform. Reserve
   * and settle budget exactly as in `fetchPage`.
   */
  execute(ctx: ConnCtx<Cfg>, action: OutboundActionInput): Promise<OutboundResult>;

  /**
   * Can we legally/technically send right now? Check messaging windows
   * (Meta 24h, TikTok Business Messaging), token scope, quota and content
   * rules (X URL-bearing write cost → a warning, not a block). A `false`
   * result never reaches the queue and its `remediation` is shown inline in
   * the composer. Should be cheap and side-effect free; it may read budget
   * but must not reserve it.
   */
  preflight(ctx: ConnCtx<Cfg>, action: OutboundActionInput): Promise<Preflight>;

  // ── health ─────────────────────────────────────────────────────────────

  /** Current budget as the limiter sees it — normally `ctx.budget.snapshot()`. */
  budget(ctx: ConnCtx<Cfg>): Promise<BudgetSnapshot>;

  /**
   * Cheap liveness + configuration check for the health console. Must not
   * consume meaningful budget (one lightweight call at most) and must never
   * throw: report problems in `checks` and `status`.
   */
  health(ctx: ConnCtx<Cfg>): Promise<HealthReport>;
}
