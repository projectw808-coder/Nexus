# ADR-019 — Keitaro's attribution engine, the `api_key` connect flow, and the four remaining connectors

**Status:** accepted (Phase 8) · **Spec:** §8.2–§8.6, §16 Phase 8 · **Builds on:** ADR-001, ADR-007, ADR-009, ADR-013, ADR-016

## Context

Phase 4–7 built the connector SDK, its budgeting/quota shapes and the sync engine generically
enough that X's credit spend, YouTube's dual budget, TikTok's two-provider split and Keitaro's
per-connection base URL were all already modeled in the SDK (`quota.ts`, `settings.ts`,
`canonical.ts`) before any of their connector packages existed. Phase 8's actual work is five
connector packages, one new sink, and a handful of gaps the SDK left for the first `api_key`
connector and the first connector whose data feeds a Deal rather than the inbox — both of which
are Keitaro.

## Decisions

1. **One Deal per Keitaro `subid`, not per `subid`+`tid`.** A `subid` is one click — one buyer's
   journey — and Keitaro's own doc comment says a `tid` merely "lets one click carry several
   conversions without overwriting." Multiple `tid`s under the same `subid` roll onto the same
   Deal; the ledger is keyed `(connectionId, subid, tid)` so each `tid`'s contribution is
   independently reversible without touching the others (`packages/sync/src/sinks/attribution.ts`).

2. **`KeitaroConversionState` is a ledger, not a cache** (mirrors ADR-002's `RecordMerge.snapshot`
   pattern): it stores `lastStatus` and `appliedPayoutCents` — what the ledger itself last put on
   the Deal — and every transition reverses exactly that amount before applying the new one.
   Reversal is therefore exact and idempotent under replay regardless of what the incoming
   payload's `previousStatus` claims; the ledger never trusts the platform's memory of its own
   prior state, the same discipline the conversation sink already applies via find-by-external-id
   upserts. Revenue is tracked as **integer cents** internally (`appliedPayoutCents`) — `CURRENCY`
   attribute values are bare floats with no arithmetic helper anywhere in the codebase, so this
   sink is deliberately the one place that never accumulates float error across repeated
   apply/reverse cycles.

3. **Deal attribution is seven new scalar `TEXT` attributes** (`attribution_campaign`,
   `_source`, `_offer`, `_affiliate_network`, `_creative`, `_landing`, `_geo`), not a JSON
   attribute — `AttributeType` has no object/blob shape, and none of the query/index/filter layer
   (`indexColumnKind`) understands one. They are set only in the sink's create path, never in an
   update, which is how "stamped at creation and immutable thereafter" (§8.6) is actually
   enforced — nothing in `updateRecord` itself protects a field from being overwritten twice.

4. **`seedSystemObjects` became idempotent by upsert** (`packages/db/src/objects/system.ts`) so a
   workspace seeded before Phase 8 gets the new Deal attributes on its next
   `ensureSystemObjects` call instead of only new workspaces getting them. `ensureSystemObjects`'s
   short-circuit (`if any system object exists, do nothing`) was replaced with a before/after
   attribute-count comparison; existing behaviour (seed once, no-op after) is unchanged for a
   workspace whose `SYSTEM_OBJECTS` hasn't grown.

5. **A new `connectApiKeyPlatform` (`packages/sync/src/connect.ts`), not a variant of
   `connectPlatform`.** Keitaro has no redirect, no multi-account discovery, and — critically — it
   is called from a tRPC mutation (`connection.connectApiKey`), unlike `connectPlatform`, which is
   only ever reached from the OAuth callback _route_ (no open transaction). Two consequences:
   - It takes an already-open `db: TenantDb` instead of opening its own `withTenant`, because
     `tenantProcedure`'s middleware already wraps the whole request in one transaction and PGlite
     has a single connection — a nested `withTenant` deadlocks waiting for a second one.
   - It does not call `writeAudit` itself; the calling mutation's `ctx.audit` is the audit of
     record, because ADR-007's enforcement counts `ctx.audit` calls specifically, not `AuditLog`
     rows written some other way.
   - It runs a live `connector.health()` check **before** writing anything, so a wrong key or an
     unreachable tracker never produces a connection that only surfaces the problem on the first
     sync.

6. **`ConnectionSettings.clientLimiter` now actually does something.** It existed in the settings
   schema since Phase 4 but nothing read it. `quotaFor()` (`packages/sync/src/context.ts`)
   overrides a `fixed_window` manifest quota's rate with the connection's own
   `requestsPerSecond`/`maxConcurrent` at bind time, used by both `bindConnection` (real syncs)
   and `provisionalCtx` (connect-time probes). Only `fixed_window` is overridable this way — the
   other three shapes are platform-published, not a customer's to tune.

7. **X's per-15-minute rate limits are not modeled as a second quota shape.** The manifest
   declares `metered_credits` (credit spend, the actual design constraint per §8.2); the
   platform's own 429s on top of that are handled the same way every connector's are — the
   generic HTTP client classifies any 429 as `RATE_LIMITED` and honours `Retry-After` — because
   `RateLimiter` serves exactly one `QuotaModel` per connector and credit spend is the one that
   determines whether a sync should even attempt the call.

8. **YouTube's `search.list` is deliberately not in `manifest.resources`.** It is unreachable from
   `listResources()` and therefore never scheduled by the engine at all; `fetchPage` additionally
   refuses it outright unless `ctx.lane === 'interactive'`, so even a direct call from a
   mis-scheduled job fails loudly with `POLICY_BLOCKED` instead of quietly burning one of the
   100 daily calls.

9. **TikTok is one connector, two provider consoles** (Business API + Display API, per §8.4),
   selected by `config.provider` — mirroring Meta's one-connector-two-platforms shape (ADR-016)
   rather than two packages. Business Messaging DMs get their own `preflight()` window check
   built exactly like Meta's 24-hour rule; the window length (48 hours) is sourced from
   third-party integrator docs, not TikTok's own — flagged for re-verification in
   `docs/connectors/tiktok.md` per the connector-sheet lint rule, since no live TikTok Business
   account exists to confirm it against.

10. **LinkedIn stays read-only for outbound in this phase.** §8.3 lists comments and reactions as
    read resources and does not ask for an outbound reply action; Lead Sync is the resource that
    matters for a CRM. The Phase 8 acceptance criterion about per-connection grants (a `member`
    read-only on LinkedIn, `engage` on Instagram) exercises the CASL ability system directly
    (`ConnectionGrant` → `defineAbilityFor`, already fully generic since Phase 1/5) and needs no
    LinkedIn-side write capability to be meaningful — the grant restricts what the _product_
    lets a user attempt, independently of what any given connector implements.

## Consequences

- Every Phase 8 connector follows the same shape the SDK already assumed: `manifest.ts` /
  `connector.ts` / `testing/<platform>-double.ts` / `fixtures/` / `connector.test.ts`, built on
  the generic `defineConnectorContract` suite and, where the OAuth flow is vanilla, the SDK's
  `exchangeAuthorizationCode`/`refreshAccessToken`/`revokeToken` helpers directly (LinkedIn, X,
  TikTok) rather than hand-rolled calls (only Meta needed those, for its long-lived-token
  exchange and Page-token fan-out).
- A `shared_secret`-verified webhook (Keitaro's postback URL, TikTok's verification token) does
  not protect body integrity, only that the sender knows the secret — the SDK contract suite's
  universal tamper-rejection webhook check does not apply to it and such connectors omit
  `spec.webhook` from `defineConnectorContract`, verifying `verifyWebhook`/`parseWebhook`
  themselves instead.
- `CreateConnectionInput.settings` (`packages/db/src/sync/connections.ts`) is typed as
  `ConnectionSettingsInput` (the pre-default shape) rather than `Partial<ConnectionSettings>`,
  matching what `upsertConnection` actually does with it (`connectionSettingsSchema.parse`) —
  this was already a latent type-vs-behaviour mismatch that `connectApiKeyPlatform`'s settings
  object exposed.
