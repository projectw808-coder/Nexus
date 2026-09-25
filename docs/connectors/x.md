# X connector

|                          |                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                  | `packages/connectors/x`                                                                                                                                                                   |
| `Platform` enum value(s) | `X`                                                                                                                                                                                       |
| API / version pinned     | X API `2` (`manifest.apiVersion`)                                                                                                                                                         |
| Auth kind                | `oauth2_pkce`                                                                                                                                                                             |
| Platform docs            | <https://developer.x.com/en/docs/x-api> (`manifest.docsUrl`)                                                                                                                              |
| Approval / tier required | Paid API tier (Basic or above) for meaningful mention/DM volume                                                                                                                           |
| **Figures verified on**  | **2026-09-25** by Claude (Phase 8 build) against the product spec §8.2 ONLY — **not** cross-checked against `developer.x.com`, because no live X developer app exists in this environment |
| Next re-verification due | 2026-10-25 (≤ 90 days; sooner if a spend cap trips in production)                                                                                                                         |

> **Every rate-card, scope, and quota figure on this page is carried over from the product
> spec, not confirmed against X's live developer portal.** X's own billing terms are described
> as changing quarterly, so treat the numbers in §8 as provisional until someone with API
> access re-checks them against `developer.x.com` and updates §15 below.

## 1. What it is for

Feeds the unified inbox with X mentions (public @-replies) and direct messages, and lets a
rep send a DM reply from Nexus. It deliberately does **not** publish original posts, reply to
comments publicly, or ingest engagement/analytics metrics — those are out of scope for this
phase. It is also read/write for one connected user only: X has no Meta-style Page fan-out, so
one OAuth grant produces exactly one `Connection`.

## 2. Capabilities

| Capability                             | Supported | Requires scope(s)          | Degraded when                                | Notes                                     |
| -------------------------------------- | --------- | -------------------------- | -------------------------------------------- | ----------------------------------------- |
| `read:mentions`                        | yes       | `tweet.read`, `users.read` | scope missing → mentions not synced          |                                           |
| `read:messages`                        | yes       | `dm.read`, `users.read`    | scope missing → DMs not synced               |                                           |
| `write:reply_dm`                       | yes       | `dm.read`, `dm.write`      | scope missing → `SCOPE_MISSING` in preflight | URL-bearing text costs 13x, never blocked |
| `write:reply_comment` (public replies) | no        | —                          | —                                            | Not built in this phase                   |
| `write:publish_post`                   | no        | —                          | —                                            | Not built in this phase                   |

## 3. Authentication

- Flow: standard OAuth 2.0 Authorization Code + PKCE (`authKind: 'oauth2_pkce'`), user-context.
  `buildAuthUrl()` throws `VALIDATION` if core does not supply a PKCE pair — X requires it.
- Redirect URI: the deployment's registered `/api/connect/callback`, forwarded verbatim from
  `AuthCtx.redirectUri`.
- Token lifetime: X access tokens are short-lived; `offline.access` grants a refresh token.
  `refresh()` uses the SDK's generic `refreshAccessToken()` — no bespoke exchange needed. A
  token with no `offline.access` grant (or a revoked refresh token) surfaces `AUTH_EXPIRED` on
  the next refresh attempt, same as any OAuth2 connector.
- Account discovery: `discoverAccounts()` calls `GET /2/users/me` and returns exactly one
  `DiscoveredAccount` (the authenticated user); there is no sub-account fan-out.
- Revocation: `revoke()` calls the SDK's generic `revokeToken()` against `/oauth/revoke`
  (RFC 7009 semantics — 2xx and 404 both count as revoked).

## 4. Scopes

| Scope id         | Plain language shown to the user                                  | Required for                                                | Sensitive (review needed) |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| `tweet.read`     | "Read your posts and the posts that mention you"                  | `read:mentions`                                             | no                        |
| `tweet.write`    | "Post and reply to posts on X on your behalf"                     | (none yet — requested for a future public-reply capability) | no                        |
| `dm.read`        | "Read your direct messages"                                       | `read:messages`                                             | **yes**                   |
| `dm.write`       | "Send direct messages on your behalf"                             | `write:reply_dm`                                            | **yes**                   |
| `users.read`     | "Look up your profile and the people you interact with"           | `read:mentions`, `read:messages`                            | no                        |
| `offline.access` | "Stay connected without you having to re-authorize every session" | (none — enables refresh for every capability)               | no                        |

Matches `manifest.scopes` exactly. `tweet.write` is requested now (with the app registration)
so that a later public-reply capability does not force every existing connection through a
re-consent round trip, but no capability currently degrades if it is missing.

## 5. Endpoints used

| Endpoint id                                  | Method + path                                | Used by (resource / action)                           | Cost (units / credits / calls)            | Page size | Notes                                                                 |
| -------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- | --------- | --------------------------------------------------------------------- |
| `GET /2/users/:id/mentions`                  | `GET /2/users/:id/mentions`                  | `x.mentions`                                          | $0.005 per mention **read**, not per call | 100       | reserve = `pageSize * rate`, settle = `items.length * rate`           |
| `GET /2/dm_events`                           | `GET /2/dm_events`                           | `x.dms`                                               | $0.01 per DM event **read**, not per call | 100       | same reserve/settle pattern                                           |
| `GET /2/users/me`                            | `GET /2/users/me`                            | `discoverAccounts`, `health`                          | not on the rate card (treated as free)    | 1         | no `budget.reserve()` — cheap, run outside the metered budget         |
| `POST /2/dm_conversations/:id/messages`      | `POST /2/dm_conversations/:id/messages`      | `reply_dm` (existing conversation)                    | $0.015 plain / **$0.20 with a URL**       | —         | `idempotency-key` header carries `OutboundActionInput.idempotencyKey` |
| `POST /2/dm_conversations/with/:id/messages` | `POST /2/dm_conversations/with/:id/messages` | `reply_dm` (no conversation id yet, only a recipient) | same as above                             | —         | used when `action.conversationExternalId` is absent                   |

`GET /2/users/me` deliberately bypasses `budget.reserve()`/`settle()` entirely (see §12): it
is a one-time/health-check call, not a rate-carded read, and `metered_credits` reservations
require a `spendCap` to already be configured — which is not guaranteed to exist yet when
`discoverAccounts()` runs during the initial OAuth callback.

## 6. Resources

| Resource id  | Kinds yielded | Default interval | Default enabled | Backfill | Webhook | Cost / page                                                                 | Lanes                              | Cursor strategy                                                                     |
| ------------ | ------------- | ---------------- | --------------- | -------- | ------- | --------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `x.mentions` | `x_mention`   | 300 s            | yes             | yes      | no      | `100 * $0.005` = $0.5 (manifest `costPerPage`, used by the quota simulator) | `delta`, `backfill`                | opaque `next_token` (X-style pagination token, modelled as an offset by the double) |
| `x.dms`      | `x_dm_event`  | 300 s            | yes             | yes      | no      | `100 * $0.01` = $1.0                                                        | `delta`, `backfill`, `interactive` | same                                                                                |

Both resources page forward from `r.highWaterMark ?? r.since` (passed as X's `start_time`
query param) and take `nextCursor` from the platform's `meta.next_token`. The high-water mark
is the newest `created_at` seen in the page. `x.dms` allows the `interactive` lane so a rep
opening a conversation can force a synchronous refresh; `x.mentions` does not need that lane.

**Deleted-on-the-platform**: X tombstones deleted posts and DMs rather than removing them from
history feeds. The raw schemas both carry a `deleted: boolean` field (defaulting to `false`
when the platform omits it); `normalize()` sets `CanonicalMessage.isDeleted: true` on a
tombstoned item and still returns it — it is never dropped from the sync (see §11).

## 7. Webhooks

- **Supported: no.** `manifest.webhooks = { supported: false, verification: 'none', resources: [], replayable: false }`.
- X's classic Account Activity webhooks are deprecated by the platform. The filtered stream
  (a persistent HTTP connection, the lower-latency/cheaper alternative X's own docs recommend)
  would be the right replacement, but implementing a real long-lived streaming connection is
  out of scope for this connector in this phase.
- `verifyWebhook()` always returns `false` and `parseWebhook()` always returns `[]` — both are
  simple, honest reflections of `webhooks.supported: false` rather than throwing, so a caller
  that (incorrectly) wires this connector into a webhook route gets a clean rejection instead
  of an exception.
- Consequence: delta ingestion for both resources is **polling only**, at the resource's
  `defaultIntervalSeconds` (300s). See §13 "Not supported" for the explicit gap this leaves.

## 8. Quota math

- Shape: `metered_credits`. X bills mention/DM reads and DM sends per use, in USD, with a
  rolling 24-hour UTC dedup window and a required per-connection monthly spend cap.
- Rate card (`manifest.quota.rateCard`, spec §8.2 — **unverified against live X billing docs**,
  see the banner at the top of this page):

  | Endpoint id    | Cost                                                           |
  | -------------- | -------------------------------------------------------------- |
  | `x.mentions`   | $0.005 / mention read                                          |
  | `x.dms`        | $0.01 / DM event read                                          |
  | `reply_dm`     | $0.015 / plain-text DM send                                    |
  | `reply_dm_url` | $0.20 / DM send whose text contains a URL (**13x** `reply_dm`) |

  `cycleCapUnits: 3_000_000` is the hard per-cycle ceiling before an Enterprise plan would be
  required (spec §8.2's "~3M post reads" figure) — again, provisional.

- **Dedup rule**: reads are billed per resource item, not per API call. `fetchPage()` reserves
  a pessimistic estimate (`pageSize * rate`) before the call — this is what makes the spend cap
  a real gate, not an after-the-fact bookkeeping exercise — then settles with the true cost
  (`items.length * rate`) once it knows how many rows came back. Every reserve/settle pair for
  a read carries `resourceKey = \`${accountExternalId}:${resourceId}\``, so the SDK's built-in
24h UTC dedup ledger makes a same-day re-poll of the same account's same resource **free**
(`req.cost`is forced to`0`at`reserve()`time;`fetchPage()`detects this — see the code
comment in`fetchResourcePage()`— and settles with`actualCost: 0` too, instead of silently
  overwriting the dedup with a nonzero recomputed cost).
- **Required spend cap**: `ConnectionSettings.spendCap.monthlyCapUnits` MUST be set before any
  `budget.reserve()` on this connection succeeds — enforced by the SDK rate limiter itself
  (`VALIDATION` if absent), not by this connector. `write:reply_dm` and both read resources are
  unusable until the customer sets one.
- **Worked example** (reproduced by `connector.test.ts`'s quota-simulator test): a customer
  polls `x.mentions` every 5 minutes and expects ~500 new mentions/day, page size 100.

  ```
  pollsPerDay  = ceil(86,400 / 300)        = 288
  pagesPerDay  = max(pollsPerDay, ceil(500 / 100)) = max(288, 5) = 288   (poll cadence dominates)
  costPerDay   = pagesPerDay * costPerPage = 288 * (100 * $0.005) = 288 * $0.5 = $144.00 / day
  ```

  Against a $5,000/month spend cap (`dailyCapacityOf` → `5000 / 30 ≈ $166.67/day`), that is
  ~86% utilization — the simulator's own 80% threshold warning fires here, correctly telling
  the customer they have little headroom for backfill or bursts.

- **Design gap, documented rather than silently modeled away**: X also enforces a _classic_
  per-endpoint call-rate limit (e.g. `x-rate-limit-limit` / `x-rate-limit-remaining` headers,
  reportedly ~450 requests/15 min on the mentions timeline) **in addition to** the dollar-based
  metered billing above. A `ConnectorManifest` has exactly one `quota` shape, and this
  connector's manifest models the metered-credits budget only. Concretely: `fetchResourcePage()`
  and `execute()` both deliberately do **not** forward `observedFromHeaders()` into
  `budget.settle()`, because the SDK's generic `applyObservedUsage()` would otherwise treat
  those call-count headers as authoritative for whatever window it is settling and silently
  clobber the real dollar spend with a call count (this was caught by a failing test while
  building this connector — see the code comment at the call site). The practical effect: a 429
  from X's call-based limiter is still correctly raised as `RATE_LIMITED` by the HTTP client
  itself (independent of the budget system), so it is not silently swallowed — it just is not
  additionally tracked as its own named window in the budget snapshot. If X's classic call
  limit becomes a real operational problem, the fix is a second `fixed_window`-shaped tracker
  layered next to this one, which the current single-`QuotaModel`-per-manifest design does not
  support without an SDK change.

## 9. Messaging-window and content rules

| Action                            | Rule                              | Preflight result          | Remediation shown                                                                                |
| --------------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `reply_dm`                        | text must be non-empty            | `VALIDATION`              | "Reply text is empty" / "Write something before sending."                                        |
| `reply_dm`                        | needs a conversation or recipient | `VALIDATION`              | "No DM conversation or recipient to reply to" / "Pick the conversation you are replying to."     |
| `reply_dm`                        | needs `dm.read` + `dm.write`      | `SCOPE_MISSING`           | "DM replies need the dm.read and dm.write scopes" / "Re-authorize the connection to grant them." |
| `reply_dm` with a URL in the text | costs 13x ($0.20 vs $0.015)       | `ok: true` with a warning | "Replies containing a URL cost 13x more on X ($0.20 instead of $0.015)."                         |
| any other `OutboundActionKind`    | not implemented                   | `POLICY_BLOCKED`          | "`<kind>` is not supported by the X connector" / "Use reply_dm."                                 |

There is no messaging-window rule modeled for X DMs in this phase (unlike Meta's 24h rule) —
`manifest.messagingWindowHours` is left unset. `preflight()` never reserves budget; it only
reads `capabilities()` (itself derived from `verifyScopes()`), which is cheap and side-effect
free per the SPI contract.

## 10. Failure codes → remediation

| Platform signal                            | `FailureClass`    | Behaviour                                                                | Remediation string (verbatim, as shown in UI)                                                  |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| HTTP 401                                   | `AUTH_EXPIRED`    | pause connection, prompt reconnect                                       | "Reconnect X — your access expired."                                                           |
| HTTP 403 (insufficient scope)              | `SCOPE_MISSING`   | disable just the affected capability                                     | "DM replies need the dm.read and dm.write scopes. Re-authorize the connection to grant them."  |
| HTTP 429                                   | `RATE_LIMITED`    | back off, keep interactive lane                                          | raised directly by the shared HTTP client, independent of the metered-credits budget (§8)      |
| the monthly spend cap would be exceeded    | `QUOTA_EXHAUSTED` | reads/writes refused before the call                                     | "the monthly spend cap of {capUnits} would be exceeded" (from the SDK rate limiter)            |
| spend past the alert threshold             | `QUOTA_EXHAUSTED` | background (non-interactive) lanes pause; interactive/webhook keep going | "spend is past {n}% of the monthly cap; background syncing paused"                             |
| 5xx streak                                 | `PLATFORM_DOWN`   | circuit open                                                             | "X is having problems. Retrying."                                                              |
| Zod failure in `normalize()`               | `SCHEMA_DRIFT`    | persist raw, quarantine                                                  | "N items need attention."                                                                      |
| no `spendCap` configured on the connection | `VALIDATION`      | every reserve() refused                                                  | "a monthly spend cap is required before this connection can make metered calls" (from the SDK) |

## 11. Normalization notes

- `x_mention` → a `CanonicalPerson` (the mention's author) **plus** a `CanonicalMessage` with
  `messageType: 'mention'`. If the author is the connected account itself (an edge case — a
  reply the account made that also mentions itself), only the message is returned, matching
  the mock/Keitaro precedent of not duplicating the connected account as a `person`.
- `x_dm_event` → the same person + message pattern with `messageType: 'dm'`,
  `conversationExternalId` = X's `dm_conversation_id`.
- `direction` is `inbound` unless the raw item's author/sender id equals
  `NormalizeCtx.accountExternalId`, in which case it is `outbound`.
- `parentExternalId`/`rootExternalId` on a mention come from `in_reply_to_user_id` and
  `conversation_id`; a DM event has no parent (`parentExternalId: null`) and its
  `rootExternalId` is the DM conversation id.
- **Tombstones**: a raw item with `deleted: true` still normalizes fully — `isDeleted: true` is
  set on the `CanonicalMessage`, and the row is never quietly dropped. See the fixture
  `x_mention.deleted.json` and the tombstone test in `connector.test.ts`.
- **Identity**: `author_id` / `sender_id` are the only identity signal used (Tier-1, per §10 of
  the product spec) — no email/phone is ever present on an X mention or DM in this connector.
- **Media**: not modelled in this phase — `attachments: []` on every message regardless of
  what the raw payload might carry; a future pass would extract media URLs into
  `Attachment[]`.

## 12. Per-connection settings that matter here

- `spendCap.monthlyCapUnits` / `spendCap.alertThresholdFraction` — **required** (see §8); every
  `x.mentions`, `x.dms`, and `reply_dm` call is refused with `VALIDATION` until set.
- `dryRun` — honoured by `execute()`: returns a synthetic `dry_<idempotencyKey>` result without
  ever calling `POST /2/dm_conversations/.../messages`.
- `resources.<id>.intervalSeconds` — overrides the 300s default poll interval per resource;
  feeds directly into the §8 worked-example arithmetic.
- `apiVersion` — pinned override is respected via `ctx.apiVersion`, though this connector does
  not currently assert a served-version drift check (`apiVersionHeader` is left unset in the
  manifest — X does not echo an API version header in the way Meta does).
- `baseUrl` / `caCertPem` / `clientLimiter` / `subIdMapping` / `clickFilter` — not applicable;
  those are Keitaro-specific self-hosted-tracker settings.

## 13. Not supported / known gaps

- **No webhooks.** X's classic Account Activity webhooks are deprecated, and the filtered
  stream (a persistent HTTP connection) is out of scope for this connector today. Delta
  ingestion is polling-only at 300s intervals. The UI should not offer a "real-time" toggle for
  this connector.
- **No public post replies or publishing.** `tweet.write` is requested (for a future capability)
  but `execute()`/`preflight()` only implement `reply_dm`; every other `OutboundActionKind`
  returns `POLICY_BLOCKED`.
- **No classic call-rate-limit tracking.** See the design-gap note in §8: X's per-endpoint call
  quota (separate from the dollar-based metered billing) is not tracked as its own budget
  window; a 429 from it still raises `RATE_LIMITED` correctly, it just is not shown as a named
  window in the health/budget UI.
- **No media extraction.** Attachments on mentions/DMs are not fetched or normalized in this
  phase.
- **Rate-card figures are unverified.** Every number in §8 came from the product spec, not a
  live check of `developer.x.com` — see the banner at the top of this page and the log in §15.

## 14. Fixture inventory

| File                     | Kind         | Captured from API version | Captured on | What it exercises                                                       |
| ------------------------ | ------------ | ------------------------- | ----------- | ----------------------------------------------------------------------- |
| `x_mention.json`         | `x_mention`  | v2 (synthetic)            | 2026-09-25  | clean inbound mention → person + message, `mention` messageType         |
| `x_mention.deleted.json` | `x_mention`  | v2 (synthetic)            | 2026-09-25  | `deleted: true` → tombstone, `isDeleted: true`, not dropped             |
| `x_mention.drift.json`   | `x_mention`  | v2 (synthetic)            | 2026-09-25  | `text` renamed to `body`, `strict()` schema rejects it → `SCHEMA_DRIFT` |
| `x_dm_event.json`        | `x_dm_event` | v2 (synthetic)            | 2026-09-25  | clean inbound DM → person + message, `dm` messageType                   |

All fixtures are hand-authored synthetic payloads shaped to match the X API v2 documented
response shape (no live X app exists in this environment to record real traffic against —
see the banner at the top of this page); replace with recorded fixtures once one is available.

## 15. Verification log

| Date       | Who              | What was checked                                                                                                                  | Changes made                                                                     |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 2026-09-25 | Claude (Phase 8) | Rate card, scopes, resource shapes against the **product spec §8.2 only** — no live X developer portal access in this environment | Initial connector build; flagged every figure for re-verification before go-live |
