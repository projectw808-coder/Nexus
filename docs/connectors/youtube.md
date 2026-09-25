# YouTube connector

|                          |                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                  | `packages/connectors/youtube`                                                                                                                                                |
| `Platform` enum value(s) | `YOUTUBE`                                                                                                                                                                    |
| API / version pinned     | YouTube Data API `v3` (`manifest.apiVersion`)                                                                                                                                |
| Auth kind                | `oauth2` (standard Google authorization-code flow, no PKCE required)                                                                                                         |
| Platform docs            | <https://developers.google.com/youtube/v3/docs> (`manifest.docsUrl`)                                                                                                         |
| Approval / tier required | Google Cloud project with the YouTube Data API v3 enabled; sensitive scopes (`force-ssl`, `yt-analytics.readonly`) need OAuth consent screen verification for production use |
| **Figures verified on**  | **2026-09-25** by Phase 8 build, corroborated by `docs/ARCHITECTURE.md` § "Things I checked rather than assumed" and the product spec                                        |
| Next re-verification due | 2026-12-24 (≤ 90 days)                                                                                                                                                       |

## 1. What it is for

Feeds the timeline (a channel's uploaded videos as `CanonicalPost`s) and the unified inbox (top-level
comment threads as `CanonicalPerson` + `CanonicalMessage`, with reply support). It deliberately does
NOT fetch YouTube Analytics data yet (the `read:insights` capability and its scope are declared but
unimplemented — see §13), does NOT run an unscheduled `search.list` sync (see §5, §8), and does NOT
call `videos.insert` (uploading new videos is out of scope for a CRM connector).

## 2. Capabilities

| Capability            | Supported | Requires scope(s)       | Degraded when                                | Notes                                                                 |
| --------------------- | --------- | ----------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| `read:posts`          | yes       | `youtube.readonly`      | scope missing → videos not synced            | via `playlistItems.list` on the uploads playlist                      |
| `read:comments`       | yes       | `youtube.readonly`      | scope missing → comments not synced          | via `commentThreads.list`                                             |
| `write:reply_comment` | yes       | `youtube.force-ssl`     | scope missing → `SCOPE_MISSING` at preflight | via `comments.insert`, costs 50 units                                 |
| `read:insights`       | no        | `yt-analytics.readonly` | —                                            | scope + capability declared; fetching deferred to a later phase (§13) |

## 3. Authentication

- Flow: standard Google OAuth2 authorization-code exchange. `buildAuthUrl` sends the user to
  Google's `/o/oauth2/v2/auth` with `access_type=offline&prompt=consent` so a refresh token is
  always issued (Google otherwise omits it on repeat consents). `exchangeCode` and `refresh` use
  the SDK's generic `exchangeAuthorizationCode` / `refreshAccessToken` helpers against Google's
  token endpoint — nothing Google-specific beyond the URLs and the offline-access params.
- Redirect URI: the deployment's registered `/api/connect/callback` (per `AuthCtx.redirectUri`),
  registered in the Google Cloud OAuth client.
- Token lifetime: Google access tokens expire in ~1 hour; `refresh()` uses the refresh token
  (which Google does not rotate) via `refreshAccessToken`. There is no scenario where YouTube has
  no refresh path — a token with no refresh token on file throws `AUTH_EXPIRED` and the user must
  re-authorize (`prompt=consent` is always requested for exactly this reason).
- Account discovery: `discoverAccounts()` calls `channels.list?mine=true` and returns the
  authenticated user's channel(s) as `DiscoveredAccount`s (`accountType: 'channel'`,
  `externalId` = the channel id, e.g. `UCxxxxxxxxxxxxxxxxxxxxxxxx`). Each channel becomes its own
  `Connection` row, exactly like a Meta Page.
- Revocation: `revoke()` calls Google's token revocation endpoint (RFC 7009) with the access
  token; best-effort, same as every other OAuth2 connector.

## 4. Scopes

| Scope id                                                | Plain language shown to the user                        | Required for                  | Sensitive (review needed) |
| ------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- | ------------------------- |
| `https://www.googleapis.com/auth/youtube.readonly`      | "See your channel, its videos and the comments on them" | `read:posts`, `read:comments` | no                        |
| `https://www.googleapis.com/auth/youtube.force-ssl`     | "Reply to and moderate comments on your videos"         | `write:reply_comment`         | yes                       |
| `https://www.googleapis.com/auth/yt-analytics.readonly` | "See performance analytics for your channel and videos" | `read:insights`               | yes                       |

Matches `manifest.scopes` exactly. No retired scopes are requested.

## 5. Endpoints used

Endpoint ids here are the exact keys used in `budget.reserve({ endpoint, cost })` and in the
manifest's `quota.unitCosts` / `quota.cappedEndpoints` tables.

| Endpoint id           | Method + path                    | Used by (resource / action)          | Cost (units)                | Page size | Notes                                                                                                                            |
| --------------------- | -------------------------------- | ------------------------------------ | --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `playlistItems.list`  | `GET /youtube/v3/playlistItems`  | `yt.videos`                          | 1 unit                      | 50        | walks the channel's uploads playlist (`UC…` → `UU…`) — discovery, not search                                                     |
| `commentThreads.list` | `GET /youtube/v3/commentThreads` | `yt.comments`                        | 1 unit                      | 50        | top-level comment threads for the channel                                                                                        |
| `comments.list`       | `GET /youtube/v3/comments`       | not called by this connector yet     | 1 unit                      | —         | would fetch replies to a thread; deferred (§13)                                                                                  |
| `comments.insert`     | `POST /youtube/v3/comments`      | `reply_comment` (`execute()`)        | 50 units                    | —         | writes cost 50× a read                                                                                                           |
| `search.list`         | `GET /youtube/v3/search`         | explicit, user-initiated search only | 1 unit **+ 1 of 100/day**   | 50        | **NEVER call this from a scheduled resource** — see the callout below                                                            |
| `videos.insert`       | `POST /youtube/v3/videos`        | not called by this connector         | 50 units **+ 1 of 100/day** | —         | uploading videos is out of scope for this connector; endpoint declared only so the shared 100-calls/day cap is modeled correctly |

> **NEVER call `search.list` from a scheduled resource.** It is not declared in
> `manifest.resources` at all, so the sync engine can never schedule it — `listResources()` returns
> only `yt.videos` and `yt.comments`. It is still reachable through
> `fetchPage(ctx, { id: 'yt.search' }, …)` for an explicit, user-initiated search (a future UI
> feature), and `fetchPage` enforces the rule itself: it throws `POLICY_BLOCKED` immediately —
> before reserving budget or calling the platform — unless `ctx.lane === 'interactive'`. Video
> discovery always uses `playlistItems.list` on the channel's uploads playlist instead.

## 6. Resources

| Resource id   | Kinds yielded       | Default interval | Default enabled | Backfill | Webhook | Cost / page | Lanes               | Cursor strategy |
| ------------- | ------------------- | ---------------- | --------------- | -------- | ------- | ----------- | ------------------- | --------------- |
| `yt.videos`   | `yt_video`          | 3600 s           | yes             | yes      | no      | 1 unit      | `delta`, `backfill` | `nextPageToken` |
| `yt.comments` | `yt_comment_thread` | 900 s            | yes             | yes      | no      | 1 unit      | `delta`, `backfill` | `nextPageToken` |

- `yt.videos`: pages the channel's uploads playlist via `playlistItems.list`; the high-water mark
  is the newest `snippet.publishedAt` seen in a page. A video the channel deletes or unlists
  simply stops appearing in future pages — there is no tombstone event from this endpoint, so
  deletion detection is a reconciliation concern, not something this resource reports directly.
- `yt.comments`: pages top-level comment threads for the whole channel via
  `commentThreads.list?channelId=…`; the high-water mark is the newest
  `topLevelComment.snippet.publishedAt`. Replies nested under a thread are not fetched by this
  resource (see §13) — only top-level threads. A comment the author or a moderator deletes stops
  appearing in later pages; no explicit deletion event is delivered.
- There is no `yt.search` resource (see §5) — it exists only as an interactive `fetchPage` target.

## 7. Webhooks

- Supported: **no**. The YouTube Data API v3 has no push/webhook mechanism for the resources this
  connector syncs. (PubSubHubbub/WebSub exists for public "a channel uploaded a new video"
  notifications, but it is unauthenticated, channel-id-only, and a different mechanism entirely —
  out of scope for this connector.) `verifyWebhook()` always returns `false` and `parseWebhook()`
  always returns `[]`.
  `subscribeWebhooks()` is a no-op.
- Every resource is reconciled purely by polling at its `defaultIntervalSeconds`.

## 8. Quota math

Shape: `daily_units` (spec §7.3) — the same shape the SDK's rate limiter already implements with
two independent bucket types tracked per connection:

1. **The daily unit pool**: 10,000 units/day, resetting at midnight **Pacific time**
   (`resetTimezone: 'America/Los_Angeles'`). Reads (`playlistItems.list`, `commentThreads.list`,
   `comments.list`, `search.list`) cost 1 unit each; writes (`comments.insert`, `videos.insert`)
   cost 50 units each.
2. **Two independent capped endpoints**, tracked entirely separately from the unit pool above:
   `search.list` and `videos.insert` are each additionally hard-capped at **100 calls/day**. A
   call to either is refused if **either** bucket is exhausted — the unit pool being nearly empty
   does not free up cap headroom, and vice versa. This is enforced by the SDK's `RateLimiter`
   (`case 'daily_units'` in both `reserve()` and `snapshot()`); the connector only has to reserve
   with the right endpoint id for the enforcement to engage.

**Worked example — steady-state polling**, a channel with 200 videos and roughly 5,000 comments
total, synced at the default intervals:

- `yt.videos` polls hourly (`defaultIntervalSeconds: 3600`) → 24 polls/day. A channel this size
  publishes at most a handful of new videos per hour, so each poll is one page:
  **24 calls × 1 unit = 24 units/day**.
- `yt.comments` polls every 15 minutes (`defaultIntervalSeconds: 900`) → 96 polls/day. Assuming
  comment volume stays under 50 new comments per 15-minute window (one page):
  **96 calls × 1 unit = 96 units/day**.
- **Steady-state total: ~120 units/day of the 10,000-unit pool (1.2%)** — enormous headroom, even
  for several channels sharing a workspace's quota (a Google Cloud project's 10,000 units/day is
  shared across every connection using that OAuth client).
- **One-time backfill** of the full history: 200 videos ÷ 50/page = 4 pages = 4 units; 5,000
  comments ÷ 50/page = 100 pages = 100 units. **Backfill total: 104 units** — trivial against the
  daily pool, and it runs in the `backfill` lane (85%→ actually 60% of the pool per
  `LANE_FRACTIONS`) so it never starves a delta poll or an interactive reply.
- **The capped endpoints bind long before the unit pool would.** Say a support team's reps run an
  interactive "search this channel's videos" feature 3 times/day each, across 20 reps: that is 60
  calls/day to `search.list`, costing only 60 of the 10,000 units — negligible on the unit side —
  but it is 60 of the _hard_ 100-calls/day cap. A single busy day with 34 more searches exhausts
  `search.list` for the rest of the day (until the Pacific-midnight reset) even though the unit
  pool still shows 9,880/10,000 remaining. This is exactly why `search.list` is banned from
  scheduled resources (§5): an automated loop would burn through 100 calls/day in seconds, long
  before the unit budget noticed anything was wrong.
- Back-off: this connector has no published "percentage used" header from YouTube to react to
  (unlike Meta), so back-off is purely the limiter's own lane-fraction gating
  (`interactive` 100% / `webhook` 95% / `delta` 85% / `backfill` 60% of whichever bucket is
  checked) plus the hard `QUOTA_EXHAUSTED` once a bucket's allowed fraction is used up.
- No client-side limiter default is needed — Google's platform limit is the only constraint;
  there is no "no published limit" fallback the way Keitaro needs.

## 9. Messaging-window and content rules

| Action          | Rule                                                        | Preflight result    | Remediation shown                                                           |
| --------------- | ----------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `reply_comment` | text must be non-empty                                      | `VALIDATION`        | "Write something before sending."                                           |
| `reply_comment` | a target comment/thread must be specified                   | `VALIDATION`        | "Pick the comment you are replying to."                                     |
| `reply_comment` | `write:reply_comment` capability must not be scope-degraded | `SCOPE_MISSING`     | "Comment replies need the youtube.force-ssl scope. Re-authorize to enable." |
| `reply_comment` | text over 10,000 characters                                 | `ok` with a warning | "Comments over 10,000 characters are rejected by YouTube."                  |
| any other kind  | not supported by this connector                             | `POLICY_BLOCKED`    | "<kind> is not supported by the YouTube connector. Use reply_comment."      |

There is no messaging-window rule (no 24-hour reply window the way Meta/TikTok DMs have) —
YouTube comment replies have no time limit.

## 10. Failure codes → remediation

| Platform signal                                   | `FailureClass`    | Behaviour                                 | Remediation string (verbatim, as shown in UI)                                                                             |
| ------------------------------------------------- | ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401 / invalid or expired token               | `AUTH_EXPIRED`    | pause connection                          | "Reconnect YouTube — your access expired."                                                                                |
| HTTP 403 insufficient scope                       | `SCOPE_MISSING`   | disable one capability                    | "Comment replies need the youtube.force-ssl scope. Re-authorize to enable."                                               |
| HTTP 429 / unit pool share used up                | `RATE_LIMITED`    | back off, keep interactive lane           | "Syncing slowly — YouTube's daily quota is nearly used up, resumes at midnight Pacific."                                  |
| `search.list` or `videos.insert` cap hit          | `QUOTA_EXHAUSTED` | halt that endpoint until reset            | "Search has hit its 100-per-day limit on this connection. Try again after midnight Pacific."                              |
| 5xx streak                                        | `PLATFORM_DOWN`   | circuit open                              | "YouTube is having problems. Retrying."                                                                                   |
| Zod failure in `normalize()`                      | `SCHEMA_DRIFT`    | persist raw, quarantine                   | "Some videos or comments need attention."                                                                                 |
| `yt.search` requested from a non-interactive lane | `POLICY_BLOCKED`  | refuse before touching budget or platform | (internal only — the sync engine never schedules this; surfaced as a caller/programming error, not a user-facing message) |
| any outbound kind other than `reply_comment`      | `POLICY_BLOCKED`  | reject at preflight                       | "<kind> is not supported by the YouTube connector."                                                                       |

## 11. Normalization notes

- `yt_video` → one `CanonicalPost`: `externalId` = `contentDetails.videoId`,
  `occurredAt`/`publishedAt` = `snippet.publishedAt`, `authorExternalId` = `snippet.channelId`,
  `mediaType: 'video'`, `body` = `snippet.title`, `sourceUrl` =
  `https://www.youtube.com/watch?v=<videoId>`. `snippet.description` and `thumbnails` stay in
  `raw` only — not promoted to typed fields this phase.
- `yt_comment_thread` → a `CanonicalPerson` (the top-level comment's author) plus a
  `CanonicalMessage` (`messageType: 'comment'`), unless the author IS the connected channel
  (`authorChannelId.value === ctx.accountExternalId`), in which case only the `CanonicalMessage`
  is emitted (mirrors the mock/Keitaro pattern of not re-creating the owner as a `person`).
  `rootExternalId` = the video id; `conversationExternalId` = `video:<videoId>`;
  `parentExternalId` is always `null` because only top-level threads are fetched (see §13 — reply
  fetching via `comments.list` is deferred).
- Identity: `authorChannelId.value` (a stable YouTube channel id) is the Tier-1 identity signal
  for a commenter; `authorDisplayName` is a Tier-2 fallback used only when `authorChannelId` is
  absent (rare, legacy Google+ comments).
- Handle-change detection: not applicable — comments carry a display name, not a durable handle,
  so there is nothing to detect a change against.
- Media: video thumbnails and comment author avatars stay as-is in `raw`/`avatarUrl` (expiring
  Google CDN URLs); nothing is materialized to S3 by this connector.

## 12. Per-connection settings that matter here

- `resources['yt.videos'].intervalSeconds` / `resources['yt.comments'].intervalSeconds` — override
  the manifest defaults (3600 s / 900 s) per connection.
- `backfillDays` — how far back `yt.videos` / `yt.comments` backfill reaches; per §8 the unit cost
  of even a full-history backfill is small, so there is no YouTube-specific reason to shorten this
  the way Keitaro/TikTok retention settings do.
- `dryRun` — honored in `execute()`: a `reply_comment` under `dryRun` returns a synthetic result
  without calling `comments.insert` or spending the 50-unit cost.
- `apiVersion` — not expected to be overridden; YouTube Data API `v3` has had no breaking version
  bump since launch, unlike Meta's Graph API.
- `spendCap`, `baseUrl`, `caCertPem`, `clientLimiter`, `subIdMapping`, `clickFilter` — not
  applicable to this connector (those exist for `metered_credits` platforms and Keitaro).

## 13. Not supported / known gaps

- **YouTube Analytics (`read:insights`)**: the `yt-analytics.readonly` scope and the
  `read:insights` capability are declared in the manifest (so consent and scope-verification wire
  up correctly), but this connector does not yet call the YouTube Analytics API. Deferred to a
  later phase; today `capabilities()` still reports `read:insights` as available since the scope,
  once granted, is not "degraded" — there is simply no resource that uses it yet.
- **Comment replies (`comments.list` with `parentId`)**: only top-level comment threads are
  fetched via `commentThreads.list`. Nested replies are not synced; `comments.list` appears in the
  manifest's `unitCosts` table (so the quota simulator can account for it once built) but
  `fetchPage` does not implement it yet.
- **`search.list` as a user-facing feature**: `fetchPage` already refuses/accepts it correctly by
  lane (§5, §8), but there is no UI surface yet that calls it with `lane: 'interactive'` — that is
  a Phase 9+ concern.
- **`videos.insert` (publishing videos)**: not implemented; this is a CRM/engagement connector,
  not a publishing tool. The endpoint is declared in the manifest purely so its shared 100-calls/day
  cap with the rest of the connection is modeled accurately by the limiter and the health/budget
  UI (§5, §6 — `videos.insert`'s bucket always shows 100/100 remaining because nothing calls it).

## 14. Fixture inventory

| File                           | Kind                | Captured from API version | Captured on | What it exercises                                                                                                        |
| ------------------------------ | ------------------- | ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `yt_video.json`                | `yt_video`          | v3                        | 2026-09-25  | clean `playlistItems.list` item → `CanonicalPost` with `mediaType: 'video'`                                              |
| `yt_comment_thread.json`       | `yt_comment_thread` | v3                        | 2026-09-25  | clean top-level `commentThreads.list` item → `CanonicalPerson` + `CanonicalMessage`, inbound vs. outbound direction      |
| `yt_comment_thread.drift.json` | `yt_comment_thread` | v3                        | 2026-09-25  | an unrecognized field (`moderationStatus`) inside the strict `topLevelComment.snippet` shape → `SCHEMA_DRIFT` quarantine |

## 15. Verification log

| Date       | Who           | What was checked                                                                                                                                                                                                                                                                                                               | Changes made            |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 2026-09-25 | Phase 8 build | `daily_units` quota shape and the independent `search.list`/`videos.insert` 100-calls/day caps against the product spec and `docs/ARCHITECTURE.md`'s "Things I checked rather than assumed"; unit costs (reads 1, writes 50); Pacific-time daily reset; scope list against Google's published YouTube Data API v3 OAuth scopes | Initial connector build |
