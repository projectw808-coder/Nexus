# TikTok connector

|                          |                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                  | `packages/connectors/tiktok`                                                                                                                                                |
| `Platform` enum value(s) | `TIKTOK`                                                                                                                                                                    |
| API / version pinned     | TikTok for Developers `v2` (`manifest.apiVersion`)                                                                                                                          |
| Auth kind                | `oauth2`                                                                                                                                                                    |
| Platform docs            | <https://developers.tiktok.com/> (`manifest.docsUrl`)                                                                                                                       |
| Approval / tier required | TikTok for Business app review (Business provider); Login Kit approval only (Display provider) — see §3 and §13                                                             |
| **Figures verified on**  | **2026-09-25** by Claude (connector author) — see the sourcing caveat in §9; TikTok's own Business Messaging docs were not directly reachable while building this connector |
| Next re-verification due | 2026-12-24 (≤ 90 days)                                                                                                                                                      |

## 1. What it is for

One connector, two consoles, selected per-connection via `TikTokConfig.provider` (`'business'`
default, `'display'`). TikTok for Business feeds the unified inbox (comment moderation, Business
Messaging DMs) and the leads pipeline (Lead Generation form submissions), plus the timeline
(owned video list + engagement counts). The Display provider is read-only public content and
profile data for whichever account authorized Login Kit — it deliberately does **not** do
messaging, comment moderation or leads, no matter which scopes a Display token happens to carry.

## 2. Capabilities

| Capability             | Supported            | Requires scope(s)      | Degraded when                                                        | Notes                                                             |
| ---------------------- | -------------------- | ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `read:posts`           | yes (both providers) | `video.list`           | scope missing → videos not synced                                    | Business: owned video list + metrics. Display: public video list. |
| `read:profile`         | yes (both providers) | `user.info.basic`      | scope missing → account discovery degraded                           |                                                                   |
| `read:followers`       | yes (both providers) | `user.info.basic`      | scope missing → follower count unavailable                           | Surfaced via the same user-info call as `read:profile`.           |
| `read:comments`        | Business only        | `video.comment.list`   | scope missing, or Display → not synced                               |                                                                   |
| `write:reply_comment`  | Business only        | `video.comment.manage` | scope missing, or Display → `POLICY_BLOCKED`                         | One scope covers reply, hide AND delete.                          |
| `write:hide_comment`   | Business only        | `video.comment.manage` | scope missing, or Display → `POLICY_BLOCKED`                         |                                                                   |
| `write:delete_comment` | Business only        | `video.comment.manage` | scope missing, or Display → `POLICY_BLOCKED`                         |                                                                   |
| `read:messages`        | Business only        | `biz.dm.read`          | scope missing, or Display → not synced                               | Business Messaging v1.3.                                          |
| `write:reply_dm`       | Business only        | `biz.dm.send`          | scope missing, outside the 48h window, or Display → `POLICY_BLOCKED` | Implemented for real — see §9; not shipped as unsupported.        |
| `read:leads`           | Business only        | `leads.retrieval`      | scope missing, or Display → not synced                               | Lead Generation form submissions.                                 |

**Business vs. Display, at a glance:**

| Provider   | `read:posts` | `read:profile` | `read:followers` | `read:comments` | comment writes | `read:messages` | `write:reply_dm` | `read:leads` |
| ---------- | :----------: | :------------: | :--------------: | :-------------: | :------------: | :-------------: | :--------------: | :----------: |
| `business` |     yes      |      yes       |       yes        |       yes       |      yes       |       yes       |       yes        |     yes      |
| `display`  |     yes      |      yes       |       yes        |     **no**      |     **no**     |     **no**      |      **no**      |    **no**    |

`connector.capabilities(ctx)` filters by `ctx.config.provider` FIRST, then by `verifyScopes()`
degradation — a Display connection never regains messaging/moderation/leads even with every
scope granted, and a Business connection with a partial grant still gets exactly the read-only
subset the missing scopes allow.

## 3. Authentication

- Flow: standard OAuth 2.0 authorization-code (no PKCE) — `buildAuthUrl` → TikTok's consent
  screen → `exchangeCode` at the token endpoint → `TokenSet` with `scope` echoed back as the
  granted-scopes list.
- Redirect URI(s): registered per Nexus deployment with the TikTok for Developers app (one app
  covers both providers; `TikTokConfig.provider` is a per-connection choice, not a different app).
- Token lifetime: TikTok access tokens are short-lived with a refresh token; `refresh()` calls the
  same token endpoint with `grant_type=refresh_token`. No refresh token on file raises
  `AUTH_EXPIRED` (SDK default via `refreshAccessToken`).
- Account discovery: `discoverAccounts()` calls `GET /v2/user/info` and returns exactly one
  account, whose `accountType` reflects the provider (`business_account` vs. `display_account`) —
  TikTok does not expose a "list of pages" the way Meta does; the authorizing account IS the
  connection.
- Revocation: `revoke()` posts to `/v2/oauth/revoke`; best-effort per the SPI contract.

## 4. Scopes

| Scope id               | Plain language shown to the user                              | Required for                                                        | Sensitive (review needed) |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| `user.info.basic`      | "See your TikTok profile and follower count"                  | `read:profile`, `read:followers`                                    | no                        |
| `video.list`           | "See the videos published by your account"                    | `read:posts`                                                        | no                        |
| `video.comment.list`   | "See comments people leave on your videos"                    | `read:comments`                                                     | yes                       |
| `video.comment.manage` | "Reply to, hide or delete comments on your videos"            | `write:reply_comment`, `write:hide_comment`, `write:delete_comment` | yes                       |
| `biz.dm.read`          | "See direct messages sent to your business account"           | `read:messages`                                                     | yes                       |
| `biz.dm.send`          | "Reply to direct messages as your business account"           | `write:reply_dm`                                                    | yes                       |
| `leads.retrieval`      | "Retrieve leads submitted through your Lead Generation forms" | `read:leads`                                                        | yes                       |

Matches `manifest.scopes` exactly. No retired scopes are requested.

## 5. Endpoints used

| Endpoint id                           | Method + path                         | Used by (resource / action)                        | Cost (units / calls) | Page size    | Notes                                                    |
| ------------------------------------- | ------------------------------------- | -------------------------------------------------- | -------------------- | ------------ | -------------------------------------------------------- |
| `GET /v2/user/info`                   | `GET /v2/user/info`                   | `discoverAccounts`, `health`                       | 1 call               | —            | Also the health-check reachability probe.                |
| `GET /v2/video/list`                  | `GET /v2/video/list`                  | `tiktok.videos`                                    | 1 call               | 20 (default) | Cursor + `has_more` pagination.                          |
| `GET /v2/business/comment/list`       | `GET /v2/business/comment/list`       | `tiktok.comments`                                  | 1 call               | 20 (default) | Business only.                                           |
| `GET /v2/business/dm/list`            | `GET /v2/business/dm/list`            | `tiktok.dms`                                       | 1 call               | 20 (default) | Business only; refuses on Display with `POLICY_BLOCKED`. |
| `GET /v2/business/lead/list`          | `GET /v2/business/lead/list`          | `tiktok.leads`                                     | 1 call               | 20 (default) | Business only; refuses on Display with `POLICY_BLOCKED`. |
| `POST /v2/business/message/send`      | `POST /v2/business/message/send`      | `execute(reply_dm)`                                | 1 call               | —            | Idempotency key header; window-gated by `preflight()`.   |
| `POST /v2/video/comment/reply`        | `POST /v2/video/comment/reply`        | `execute(reply_comment)`                           | 1 call               | —            | Business only.                                           |
| `POST /v2/video/comment/manage`       | `POST /v2/video/comment/manage`       | `execute(hide_comment)`, `execute(delete_comment)` | 1 call               | —            | Single endpoint, `action: 'hide' \| 'delete'`.           |
| `POST /v2/business/webhook/subscribe` | `POST /v2/business/webhook/subscribe` | `subscribeWebhooks(tiktok.dms, tiktok.leads)`      | 1 call               | —            | Idempotent.                                              |

## 6. Resources

| Resource id       | Kinds yielded    | Default interval | Default enabled | Backfill | Webhook | Cost / page | Lanes                                 | Cursor strategy       |
| ----------------- | ---------------- | ---------------- | --------------- | -------- | ------- | ----------- | ------------------------------------- | --------------------- |
| `tiktok.videos`   | `tiktok_video`   | 900 s            | yes             | yes      | no      | 1           | delta, backfill                       | numeric offset cursor |
| `tiktok.comments` | `tiktok_comment` | 300 s            | yes             | yes      | no      | 1           | delta, backfill, interactive          | numeric offset cursor |
| `tiktok.dms`      | `tiktok_dm`      | 60 s             | yes (Business)  | yes      | yes     | 1           | delta, backfill, webhook, interactive | numeric offset cursor |
| `tiktok.leads`    | `tiktok_lead`    | 900 s            | yes (Business)  | yes      | yes     | 1           | delta, backfill, webhook              | numeric offset cursor |

- **`tiktok.videos`**: `GET /v2/video/list` with `cursor`/`max_count`; the platform double models
  the common `{ data: { videos, cursor, has_more } }` shape. High-water mark is the newest
  `create_time`. A deleted video simply stops appearing in the list — there is no tombstone event.
- **`tiktok.comments`**: same cursor shape against `/v2/business/comment/list`. Business only in
  practice (the endpoint requires Business scopes), though the resource descriptor itself does not
  encode that — `fetchPage` does not special-case Display here because comments read access is
  already gated by `video.comment.list` scope verification, and Display tokens are never granted
  it.
- **`tiktok.dms`**: `fetchPage` explicitly throws `POLICY_BLOCKED` when `config.provider ===
'display'`, on top of the scope gate, because Business Messaging is architecturally unavailable
  outside Business regardless of scopes. High-water mark is the newest message `create_time`.
- **`tiktok.leads`**: same explicit Display refusal as `tiktok.dms`. One raw item per lead
  submission; there is no "deleted lead" signal from the platform.

## 7. Webhooks

- Supported: yes, for `tiktok.dms` (new-message push) and `tiktok.leads` (form-submission push).
  Verification: `hmac_sha256` over the raw body via `verifyHmacSha256`, with the signature in the
  `x-tiktok-signature: sha256=<hex>` header — this legitimately protects body integrity (unlike
  Keitaro's query-string shared secret), so `spec.webhook` is exercised in the contract suite with
  real tamper-rejection.
- Topics: `message.receive` (→ `tiktok.dms`), `lead.submit` (→ `tiktok.leads`). Any other `event`
  value causes `parseWebhook` to return `[]` rather than throw.
- Handshake: none modeled; an unrecognized or malformed body returns `[]` (ack, no envelope).
- Ack budget: verification and parsing are synchronous and do no I/O, well under the 200 ms ack
  budget.
- Replay: not replayable (`manifest.webhooks.replayable: false`) — the `tiktok.dms` /
  `tiktok.leads` polling intervals above are the reconciliation path for anything missed.
- `connectionHint` extraction: the connection id comes from the webhook path
  (`/webhooks/tiktok/:connectionId`, same convention as Mock/Keitaro); for `message.receive` the
  `accountExternalId` hint is the message's `to_user_id`.

## 8. Quota math

- Shape: `fixed_window`, `windowSeconds: 86400`, `limit: 100000`.
- **This is a placeholder, not a published platform figure.** TikTok's Business/Marketing API
  rate limits vary by product (Business Account API, Business Messaging, Lead Generation) and by
  the app's approved tier, and are not consolidated in one publicly documented number. 100,000
  calls/day is a conservative planning default; replace it with the customer's actual approved
  tier once TikTok for Business app review is complete, the same way `docs/connectors/keitaro.md`
  flags its client-side limiter as OUR default rather than a platform-published one.
- Worked example (placeholder tier): a connection syncing videos every 15 min (96 calls/day),
  comments every 5 min (288 calls/day), DMs every 60 s (1,440 calls/day) and leads every 15 min
  (96 calls/day) totals ~1,920 calls/day — under 2% of the 100,000/day placeholder ceiling, so the
  simulator should not flag a normal connection even before the real tier is known.
- Back-off threshold: none platform-published; the SDK's `RateLimiter` still applies observed
  `x-ratelimit-remaining`-style headers over the static limit when TikTok returns them (see
  `observedFromHeaders`).

## 9. Messaging-window and content rules

| Action                                                                      | Rule                                          | Preflight result                               | Remediation shown                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reply_dm`                                                                  | 48 h from the customer's last inbound message | `POLICY_BLOCKED` after expiry, or never-opened | "The 48-hour messaging window closed at {ISO time} — TikTok Business Messaging only allows replies within 48 hours of the customer's last message." |
| `reply_dm` with < 1 h left on the window                                    | —                                             | `ok: true` with a warning                      | "The messaging window closes in {N} minutes."                                                                                                       |
| `reply_dm` / `reply_comment` / `hide_comment` / `delete_comment` on Display | Business-only action                          | `POLICY_BLOCKED`                               | "{action} requires TikTok for Business — this connection uses the Display provider."                                                                |

`replyWindowExpiresAt` is computed on every inbound DM as `sentAt + 48h` (`WINDOW_MS` in
`connector.ts`, mirroring `@nexus/connector-meta`'s `WINDOW_MS` pattern exactly) and copied onto
the parent `CanonicalConversation` as well, so the composer's countdown reads it without a second
lookup. **The 48-hour figure itself is sourced from third-party integrator documentation
(SleekFlow, Respond.io) describing TikTok Business Messaging, not from TikTok's own developer
docs** — those were not directly accessible while building this connector. Re-verify against
TikTok's official Business Messaging documentation before relying on this number in production;
until then, treat it as the best available estimate, not a confirmed platform guarantee.

Per the spec, TikTok DMs are shipped as a fully working feature, not a placeholder refusal:
`execute(reply_dm)` performs a real `POST /v2/business/message/send` call once `preflight()`
passes, exactly like Meta's `reply_dm`/`send_dm`.

## 10. Failure codes → remediation

| Platform signal                        | `FailureClass`                | Behaviour                          | Remediation string (verbatim, as shown in UI)                                                 |
| -------------------------------------- | ----------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| HTTP 401 / invalid or expired token    | `AUTH_EXPIRED`                | pause connection, prompt reconnect | "Reconnect TikTok — your access expired."                                                     |
| Scope missing for the requested action | `SCOPE_MISSING`               | disable just that capability       | "{action} needs the {scope id} scope. Re-authorize TikTok to grant it."                       |
| Business-only action on Display        | `POLICY_BLOCKED`              | refuse the action                  | "{action} requires TikTok for Business — this connection uses the Display provider."          |
| 48h Business Messaging window expired  | `POLICY_BLOCKED`              | refuse the send                    | "The 48-hour messaging window closed at {ISO time} — … Wait for the customer to write again." |
| HTTP 429                               | `RATE_LIMITED`                | back off, retry later              | (surfaced via the standard rate-limit banner; `retryAfter` from `retry-after` header).        |
| 5xx / timeout streak                   | `PLATFORM_DOWN`               | circuit open                       | "TikTok is having problems. Retrying."                                                        |
| Zod failure in `normalize()`           | `SCHEMA_DRIFT`                | persist raw, quarantine            | "N items need attention."                                                                     |
| Unknown resource id / unknown kind     | `VALIDATION` / `SCHEMA_DRIFT` | reject the call / quarantine       | (internal — should never surface from correctly configured sync scheduling).                  |

## 11. Normalization notes

| Platform object              | Canonical kind(s)                                                                  | `externalId`                                                            | `parentExternalId` / `rootExternalId`                             |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tiktok_video`               | `post`                                                                             | `video.id`                                                              | both `null` (top-level content)                                   |
| `tiktok_comment` (top-level) | `message` (`messageType: 'comment'`) + `person` (author, if inbound)               | `comment.comment_id`                                                    | `parentExternalId: null`, `rootExternalId: video_id`              |
| `tiktok_comment` (reply)     | `message` (`messageType: 'reply'`) + `person`                                      | `comment.comment_id`                                                    | `parentExternalId: parent_comment_id`, `rootExternalId: video_id` |
| `tiktok_dm`                  | `conversation` + `message` (`messageType: 'dm'`) + `person` (customer, if inbound) | `message.message_id` (message), `` `dm:${customerId}` `` (conversation) | both `null` on the message; conversation carries the thread       |
| `tiktok_lead`                | `lead`                                                                             | `lead.lead_id`                                                          | not applicable                                                    |

- Typed fields: video stats (`view_count`/`like_count`/`comment_count`/`share_count`) land in
  `CanonicalPost.stats`; lead `field_data` entries named `full_name`/`email`/`phone_number` are
  extracted into the typed `fullName`/`email`/`phone` fields (E.164 and basic email shape checked
  before assignment, exactly like the Meta lead-form normalizer) while every field stays in
  `CanonicalLead.fields` verbatim.
- Identity: the DM customer id (`from_user_id` when inbound, `to_user_id` when outbound) and the
  comment author's `open_id` are the Tier-1 identity signal; TikTok does not expose IP address or
  device fingerprint on any of these resources, so nothing beyond the platform id and (for leads)
  the submitted email/phone is used for identity resolution.
- Handle changes: `display_name`/`username`-equivalent fields are not treated as a stable
  identity key — only `open_id` is.
- Media: video cover images are kept as the platform's own (expiring) CDN URL in
  `CanonicalPost.media`; nothing is proactively fetched to S3 by this connector.

## 12. Per-connection settings that matter here

- `ConnectionSettings.retentionDays`: TikTok's data-retention expectations are stricter than most
  platforms (see `manifest.constraints`); the connect flow should default new TikTok connections
  to a lower `retentionDays` than the platform-wide default. This is UI/connect-flow guidance —
  the manifest and connector do not themselves enforce a retention ceiling.
- `ConnectionSettings.dryRun`: honored in `execute()` for every outbound action kind — returns a
  synthetic `dry_*` result without reaching the platform.
- `ConnectionSettings.baseUrl` / `caCertPem`: not applicable — TikTok is a shared hosted platform,
  not self-hosted like Keitaro. `TikTokConfig.baseUrl` (connector-level, not per-connection) only
  exists to point tests at the double.
- `TikTokConfig.provider`: not a `ConnectionSettings` field but a connector static config read
  per-connection from `ConnCtx.config`; it is the one setting that changes which capabilities,
  resources and outbound actions are even reachable (see §2).

## 13. Not supported / known gaps

- **Publishing** (`write:publish_post`) is not implemented — TikTok's Content Posting API is a
  separate approval track not in scope for this phase. The UI should not offer a "compose video"
  action for TikTok connections.
- **Insights/analytics** (`read:insights`) is not implemented as a separate resource — the video
  list already carries point-in-time stats (`view_count`/`like_count`/etc.); a dedicated
  time-series insights resource was judged out of scope for Phase 8's messaging/leads/moderation
  focus and can be added later without changing the manifest's capability vocabulary.
- **Display provider messaging/moderation/leads**: architecturally impossible, not merely
  unimplemented — `capabilities()`, `preflight()`, `execute()` and `fetchPage()` all refuse these
  regardless of scopes, and the UI should not present them as connectable options for a Display
  connection.
- **The 48-hour messaging window figure** is unverified against TikTok's own docs (see §9) —
  treat any DM-window UI copy derived from it as provisional until re-verified.
- **Quota figures** (§8) are OUR conservative placeholder, not a published TikTok limit — the
  quota simulator will need updating once the customer's actual approved tier is known.

## 14. Fixture inventory

| File                      | Kind             | Captured from API version | Captured on | What it exercises                                                                            |
| ------------------------- | ---------------- | ------------------------- | ----------- | -------------------------------------------------------------------------------------------- |
| `tiktok_video.json`       | `tiktok_video`   | v2                        | 2026-09-25  | Clean video → `post` with stats and a cover image.                                           |
| `tiktok_video.drift.json` | `tiktok_video`   | v2                        | 2026-09-25  | Unrecognized extra field (`boosted_status`) → `SCHEMA_DRIFT` under the strict schema.        |
| `tiktok_comment.json`     | `tiktok_comment` | v2                        | 2026-09-25  | Top-level (non-reply) inbound comment → `message` + `person`.                                |
| `tiktok_dm.json`          | `tiktok_dm`      | v2                        | 2026-09-25  | Inbound customer DM → `conversation` + `message` with `replyWindowExpiresAt`.                |
| `tiktok_lead.json`        | `tiktok_lead`    | v2                        | 2026-09-25  | Lead Generation submission with full_name/email/phone_number → typed `CanonicalLead` fields. |

These fixtures are illustrative — modeled on TikTok's publicly documented Business/Marketing API
response shapes, not captured from a live app, since this connector was built without a live
TikTok for Business app review in hand. Replace with recorded, secret-scrubbed payloads the first
time a real Business account syncs.

## 15. Verification log

| Date       | Who                       | What was checked                                                                                                                                                                                                                                                                                                               | Changes made                                                                                                                                                                                                                           |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-25 | Claude (connector author) | Manifest shape against the SDK's `connectorManifestSchema`; scopes/capabilities/resources built from the spec's Phase 8 description; searched for the Business Messaging window duration and found only third-party integrator sources (SleekFlow, Respond.io) citing 48 hours — TikTok's own docs were not directly reachable | Initial connector build: manifest, connector, testing double, fixtures, contract + unit tests, this document. Flagged the 48h window and the quota figures as needing re-verification against TikTok's own docs before production use. |
