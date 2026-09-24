# Connector capability sheets

Every platform connector ships a capability sheet at `docs/connectors/<platform>.md`
(`meta.md`, `x.md`, `linkedin.md`, `tiktok.md`, `youtube.md`, `google.md`, `keitaro.md`, `mock.md`).
The sheet is the human-readable twin of the connector's `ConnectorManifest`
(`@nexus/connector-sdk`): anything a number in the manifest depends on is justified here,
and the `new-connector` scaffold generates the skeleton below.

The platforms change quarterly. **Every figure on a sheet carries the date it was verified
against the platform's live docs**, and a sheet whose verification date is older than 90 days
fails the docs lint. Do not copy a number from the product spec without re-checking it.

Rules:

- The sheet describes what the connector _does_, not what the platform _offers_. If a resource
  or capability is not implemented, say so in "Not supported" rather than omitting it.
- Every endpoint the connector calls appears in the endpoints table — the table is the source
  for the quota math and for the manifest's `unitCosts` / `rateCard` / `perEndpoint` keys.
- Every `FailureClass` the connector can raise has a remediation string, and that string is the
  one the UI shows. Keep it in the user's language, name the platform, and say what to click.
- Fixtures listed in the inventory exist under `packages/connectors/<name>/fixtures/` and are
  what the contract test suite replays through `normalize()`.

---

## Template

Copy everything below this line into `docs/connectors/<platform>.md` and fill each section.
Delete a section only if you replace it with an explicit "Not applicable — <why>".

```markdown
# <Platform display name> connector

|                          |                                                             |
| ------------------------ | ----------------------------------------------------------- |
| Package                  | `packages/connectors/<name>`                                |
| `Platform` enum value(s) | `FACEBOOK`, `INSTAGRAM`                                     |
| API / version pinned     | Graph API `v26.0` (`manifest.apiVersion`)                   |
| Auth kind                | `oauth2` / `oauth2_pkce` / `oauth1a` / `api_key`            |
| Platform docs            | <https://…> (`manifest.docsUrl`)                            |
| Approval / tier required | e.g. App Review + Business Verification for advanced access |
| **Figures verified on**  | **YYYY-MM-DD** by <name> against <doc URL(s)>               |
| Next re-verification due | YYYY-MM-DD (≤ 90 days)                                      |

## 1. What it is for

Two or three sentences: which Nexus surfaces this connector feeds (inbox, timeline, leads
pipeline, Deal attribution, reports) and what it deliberately does NOT do.

## 2. Capabilities

| Capability           | Supported | Requires scope(s) | Degraded when                         | Notes           |
| -------------------- | --------- | ----------------- | ------------------------------------- | --------------- |
| `read:messages`      | yes       | `pages_messaging` | scope missing → DMs not synced        |                 |
| `write:reply_dm`     | yes       | `pages_messaging` | outside 24h window → `POLICY_BLOCKED` |                 |
| `write:publish_post` | no        | —                 | —                                     | Not built in v1 |

List every value of `Capability`, including the unsupported ones.

## 3. Authentication

- Flow: step-by-step (user token → long-lived exchange → `/me/accounts` → per-Page tokens …).
- Redirect URI(s) registered.
- Token lifetime, refresh path, what `refresh()` does; what happens when no refresh path exists.
- Account discovery: what `discoverAccounts()` returns and how each item maps to a `Connection`.
- Revocation: what `revoke()` calls; what the user must do platform-side.

## 4. Scopes

| Scope id                    | Plain language shown to the user           | Required for                           | Sensitive (review needed) |
| --------------------------- | ------------------------------------------ | -------------------------------------- | ------------------------- |
| `instagram_manage_comments` | "Read and reply to comments on your posts" | `read:comments`, `write:reply_comment` | yes                       |

Must match `manifest.scopes` exactly. Note retired scopes that must NOT be requested.

## 5. Endpoints used

Every call the connector makes. Endpoint ids here are the keys used in `budget.reserve()`
and in the manifest quota tables.

| Endpoint id          | Method + path                   | Used by (resource / action) | Cost (units / credits / calls) | Page size | Notes                              |
| -------------------- | ------------------------------- | --------------------------- | ------------------------------ | --------- | ---------------------------------- |
| `playlistItems.list` | `GET /youtube/v3/playlistItems` | `yt.videos`                 | 1 unit                         | 50        | discovery instead of `search.list` |
| `search.list`        | `GET /youtube/v3/search`        | user-initiated search only  | 1 unit **+ 1 of 100/day**      | 50        | banned from sync paths             |

## 6. Resources

| Resource id      | Kinds yielded   | Default interval | Default enabled | Backfill   | Webhook | Cost / page | Lanes           | Cursor strategy      |
| ---------------- | --------------- | ---------------- | --------------- | ---------- | ------- | ----------- | --------------- | -------------------- |
| `ig.comments`    | `ig_comment`    | 300 s            | yes             | yes        | yes     | 1           | all             | platform cursor      |
| `keitaro.clicks` | `keitaro_click` | 3600 s           | **no**          | never full | no      | 1           | delta, backfill | `datetime` + overlap |

For each resource add a short paragraph: how pagination works, what the high-water mark is,
the overlap window, and what "deleted on the platform" looks like.

## 7. Webhooks

- Supported: yes/no. Verification scheme (`hmac_sha256` over raw body with `<secret>`, `jwt`, …).
- Topics / fields subscribed, and the resource each one feeds.
- Handshake / challenge handling (`parseWebhook()` returns `[]` for pings).
- Ack budget: reply within 200 ms; what the platform does to slow endpoints.
- Replay: can missed deliveries be re-requested? If not, the reconciliation poll interval.
- `connectionHint` extraction: which field in the payload identifies the account.

## 8. Quota math

State the `QuotaModel` shape used and show the arithmetic behind the numbers.

- Shape: `fixed_window` / `rolling_hour` / `daily_units` / `metered_credits`.
- Published limits (with links) and which response headers override them.
- Worked example the quota simulator must reproduce, e.g.
  "10k followers, comments every 5 min, insights hourly → 288 + 24 + … = N units/day of 10,000".
- Back-off threshold (e.g. 80% of any Meta pool) and what the user sees.
- For `metered_credits`: the rate card, the dedup rule, the required spend-cap field, and a
  worked monthly projection.
- For `daily_units`: the reset timezone and the separate capped-endpoint buckets.
- Client-side limiter defaults where the platform publishes nothing (Keitaro: 2 rps, 2 concurrent).

## 9. Messaging-window and content rules

What `preflight()` enforces, per action kind:

| Action                  | Rule                                  | Preflight result              | Remediation shown                                                                           |
| ----------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `reply_dm`              | 24 h from user's last inbound message | `POLICY_BLOCKED` after expiry | "This conversation's reply window closed at 14:32. Wait for the customer to message again." |
| `publish_post` with URL | costs 13×                             | `ok` with warning             | "Posts containing a link cost $0.20 on X."                                                  |

Include how `replyWindowExpiresAt` is computed on inbound messages.

## 10. Failure codes → remediation

| Platform signal              | `FailureClass`  | Behaviour                       | Remediation string (verbatim, as shown in UI)                               |
| ---------------------------- | --------------- | ------------------------------- | --------------------------------------------------------------------------- |
| HTTP 401 / `invalid_grant`   | `AUTH_EXPIRED`  | pause connection                | "Reconnect Instagram — your access expired on {date}."                      |
| HTTP 403 code 10             | `SCOPE_MISSING` | disable one capability          | "Comment replies need `instagram_manage_comments`. Re-authorize to enable." |
| HTTP 429 / usage > 95%       | `RATE_LIMITED`  | back off, keep interactive lane | "Syncing slowly — quota at 95%, resumes {time}."                            |
| 5xx streak                   | `PLATFORM_DOWN` | circuit open                    | "{Platform} is having problems. Retrying."                                  |
| Zod failure in `normalize()` | `SCHEMA_DRIFT`  | persist raw, quarantine         | "3 items need attention."                                                   |
| served version ≠ pinned      | `SCHEMA_DRIFT`  | alert                           | "Meta served v25.0 instead of the pinned v26.0."                            |

Cover every `FailureClass` the connector can emit; list platform error codes individually.

## 11. Normalization notes

- Mapping table: platform object → `CanonicalEntity` kind(s), with `externalId`, `occurredAt`,
  `parentExternalId` / `rootExternalId` semantics.
- Which platform fields land in typed canonical fields vs. stay only in `raw`.
- Identity: which fields are Tier-1 / Tier-2 signals (§10); what is deliberately NOT used
  (e.g. IP address on Keitaro rows).
- Handle-change detection.
- Media: what is fetched to S3 and what stays as an expiring URL in `raw`.

## 12. Per-connection settings that matter here

Which `ConnectionSettings` fields this connector reads and their platform-specific defaults
(`retentionDays` lower for TikTok/Keitaro, `spendCap` required for X, `baseUrl` + `caCertPem`
for Keitaro, `subIdMapping`, `clickFilter`).

## 13. Not supported / known gaps

Bullet list with the reason (platform limitation, approval gate, deferred to a later phase)
and what the UI says instead of failing.

## 14. Fixture inventory

Files under `packages/connectors/<name>/fixtures/`, one row each. Every `kind` the connector
yields has at least one fixture, plus one drifted fixture that must be quarantined.

| File                    | Kind         | Captured from API version | Captured on | What it exercises                                    |
| ----------------------- | ------------ | ------------------------- | ----------- | ---------------------------------------------------- |
| `ig_comment.reply.json` | `ig_comment` | v26.0                     | 2026-09-24  | nested reply → `parentExternalId` + `rootExternalId` |
| `ig_comment.drift.json` | `ig_comment` | v26.0                     | 2026-09-24  | unknown field shape → `SCHEMA_DRIFT`                 |
| `webhook.messages.json` | webhook body | v26.0                     | 2026-09-24  | signature + `parseWebhook` split                     |

## 15. Verification log

| Date       | Who    | What was checked                                | Changes made                    |
| ---------- | ------ | ----------------------------------------------- | ------------------------------- |
| 2026-09-24 | <name> | quota figures, scopes, rate card against <URLs> | none / bumped `search.list` cap |
```
