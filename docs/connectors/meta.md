# Meta connector — Facebook Pages + Instagram

Package: `packages/connectors/meta` (`@nexus/connector-meta`). Platforms: `FACEBOOK` (Pages) and
`INSTAGRAM` (professional accounts linked to a Page). One Meta app, one Facebook Login for
Business, one `Connection` row per Page and per Instagram account, each pausable on its own.

> Figures are the state of play as of September 2026 (Graph API **v26.0**, released 29 Jul
> 2026). Verify every number against Meta's live docs at upgrade time; the version-drift
> monitor flags a sunset inside 180 days and asserts the served version on every response.

## Setup checklist (what the integrations page renders)

1. A Meta app in **Live** mode with Facebook Login for Business; `META_APP_ID`, `META_APP_SECRET`,
   `META_WEBHOOK_VERIFY_TOKEN` in the environment (`META_LOGIN_CONFIG_ID` when a login
   configuration is used).
2. Redirect URI `${APP_URL}/api/connect/facebook/callback` registered on the app.
3. Webhook callback `${APP_URL}/api/webhooks/facebook` (Page topics) and
   `${APP_URL}/api/webhooks/instagram` (Instagram topics) with the verify token; Instagram
   fields (`comments`, `mentions`, `messages`) are subscribed at the **app** level in the
   dashboard; Page fields are subscribed per Page on connect (`/{page}/subscribed_apps`).
4. **Advanced Access** through App Review + Business Verification for the sensitive scopes.
   Until then Standard Access only returns data for people with a role on the app — the
   connection shows the affected capabilities as degraded ("what you can do with standard
   access").

## Auth

`GET https://www.facebook.com/v26.0/dialog/oauth` → code → `GET /v26.0/oauth/access_token`
(short-lived user token) → `grant_type=fb_exchange_token` (long-lived, ~60 days) →
`GET /me/permissions` (granted scopes) → `GET /me/accounts?fields=…,instagram_business_account`
(Page tokens + linked IG accounts).

A Page/IG connection's vault entry holds `{ accessToken: <Page token>, refreshToken: <long-lived
user token>, expiresAt: <user token expiry>, raw.pageId }`. The 70% sweep calls `refresh()`,
which re-exchanges the user token and re-reads the Page token — Meta's "scheduled
re-exchange". Revoke = `DELETE /me/permissions`.

## Scopes

| Scope                       | Plain language                  | Required for                                                                                      |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pages_show_list`           | See the Pages you manage        | `read:profile`                                                                                    |
| `pages_read_engagement`     | Read posts, comments, reactions | `read:comments` `read:posts` `read:mentions` `read:reviews`                                       |
| `pages_manage_metadata`     | Subscribe Pages to webhooks     | —                                                                                                 |
| `pages_messaging`           | Read/reply to Messenger         | `read:messages` `write:reply_dm`                                                                  |
| `pages_manage_engagement`   | Reply/hide/delete comments      | `write:reply_comment` `write:hide_comment` `write:delete_comment`                                 |
| `instagram_basic`           | See the IG account and media    | `read:posts`                                                                                      |
| `instagram_manage_messages` | Read/reply to IG DMs            | `read:messages` `write:reply_dm`                                                                  |
| `instagram_manage_comments` | IG comments and mentions        | `read:comments` `read:mentions` `write:reply_comment` `write:hide_comment` `write:delete_comment` |
| `instagram_manage_insights` | IG insights, demographics       | `read:insights` `read:followers`                                                                  |
| `leads_retrieval`           | Lead form submissions           | `read:leads`                                                                                      |
| `business_management`       | Business Manager assets         | —                                                                                                 |

## Resources and endpoints

| Resource           | Endpoint (all under `/v26.0`)                                     | Kinds                           | Default poll          |
| ------------------ | ----------------------------------------------------------------- | ------------------------------- | --------------------- |
| `fb.conversations` | `GET /{page}/conversations?fields=…,messages.limit(50){…}`        | `fb_conversation`, `fb_message` | 60 s                  |
| `fb.comments`      | `GET /{page}/feed?fields=…,comments.limit(100){…}`                | `fb_post`, `fb_comment`         | 5 min                 |
| `fb.mentions`      | `GET /{page}/tagged`                                              | `fb_mention`                    | 5 min                 |
| `fb.reviews`       | `GET /{page}/ratings`                                             | `fb_review`                     | 1 h                   |
| `fb.leads`         | `GET /{page}/leadgen_forms?fields=…,leads.limit(100){…}`          | `fb_lead`                       | 5 min                 |
| `fb.insights`      | `GET /{page}/insights?metric=…&period=day`                        | `fb_insight`                    | 1 h                   |
| `ig.dms`           | `GET /{ig}/conversations?platform=instagram&fields=…`             | `ig_conversation`, `ig_message` | 60 s                  |
| `ig.comments`      | `GET /{ig}/media?fields=…,comments{…,replies{…}}`                 | `ig_media`, `ig_comment`        | 5 min                 |
| `ig.mentions`      | `GET /{ig}/tags`                                                  | `ig_mention`                    | 5 min                 |
| `ig.insights`      | `GET /{ig}/insights?metric=…&period=day`                          | `ig_insight`                    | 1 h                   |
| `ig.followers`     | `GET /{ig}/insights?metric=follower_demographics&period=lifetime` | `ig_demographic`                | daily, off by default |

Cursor: `paging.cursors.after` while `paging.next` is present. Nested-field queries are
charged 2 in the budget.

Conversation ids converge from both directions: a DM thread is `dm:<customer psid>` whether it
came from the poll (participants) or the webhook (sender/recipient); comment threads are
`post:<post id>` / `media:<media id>`; mentions `mention:<object id>`.

## Webhooks (six topics)

`X-Hub-Signature-256` = HMAC-SHA256 of the raw body with the app secret; the GET challenge
echoes `hub.challenge` when `hub.verify_token` matches. Payloads `{ object: 'page' |
'instagram', entry: [{ id, time, messaging[] | changes[{ field, value }] }] }`:

| Topic           | Field                                      | Envelope kind                                            |
| --------------- | ------------------------------------------ | -------------------------------------------------------- |
| Messages        | `messaging[].message`                      | `fb_message_event` / `ig_message_event`                  |
| Postbacks       | `messaging[].postback`                     | `fb_message_event` (body `[postback] …`)                 |
| Feed (comments) | `changes[].field = feed`, `item = comment` | `fb_feed_change`                                         |
| IG comments     | `changes[].field = comments`               | `ig_comment`                                             |
| IG mentions     | `changes[].field = mentions`               | `ig_mention`                                             |
| Lead forms      | `changes[].field = leadgen`                | `fb_leadgen_event` (ids only; the poll fills the fields) |

Ack path: verify → `WebhookEvent` → enqueue → 200. Own messages arrive as `is_echo` events and
become outbound rows.

## Quota

Rolling-hour pools (per app, per Page, per business use case). `X-App-Usage`, `X-Page-Usage`
and `X-Business-Use-Case-Usage` are parsed on every response; the highest percentage across
pools feeds the limiter, which holds background lanes at 80% and everything at 100%.
`estimated_time_to_regain_access` becomes a hard `retryAfter`. Published fallback: 4,800
calls/hour.

## Messaging window

Standard messaging is allowed for 24 hours after the customer's last message. Every inbound
DM carries `replyWindowExpiresAt`; the conversation inherits the newest; the composer shows a
live countdown; `preflight()` blocks `reply_dm` outside the window with the closing time and
the remediation "the window reopens with their next message". Tagged messages outside the
window are not sent by this connector.

## Outbound

| Action           | Endpoint                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `reply_dm`       | `POST /{page-or-ig}/messages` `{ recipient: { id }, messaging_type: RESPONSE, message: { text } }` |
| `reply_comment`  | `POST /{comment}/comments` (FB) · `POST /{comment}/replies` (IG)                                   |
| `hide_comment`   | `POST /{comment}?is_hidden=true` (FB) · `?hide=true` (IG)                                          |
| `delete_comment` | `DELETE /{comment}`                                                                                |

## Failure codes → remediation

| Graph error                       | Class           | What the user sees                                                      |
| --------------------------------- | --------------- | ----------------------------------------------------------------------- |
| code 190 (any HTTP status), 401   | `AUTH_EXPIRED`  | Reconnect Facebook — your access expired on …                           |
| codes 4, 17, 32, 613, 80001–80014 | `RATE_LIMITED`  | Syncing slowly — quota at N%, resumes …                                 |
| codes 10, 200–299                 | `SCOPE_MISSING` | Comment replies need `pages_manage_engagement`. Re-authorize to enable. |
| code 100 subcode 33               | `NOT_FOUND`     | The object no longer exists                                             |
| codes 1, 2, HTTP 5xx              | `PLATFORM_DOWN` | Facebook is having problems. Retrying.                                  |
| served version ≠ pinned           | `SCHEMA_DRIFT`  | Health check: "Graph served v25.0; pinned v26.0" + upgrade task         |

## Version-drift monitor

Weekly job `meta.version_monitor`: `checkGraphVersion()` merges the built-in release table with
an optional JSON mirror (`META_VERSIONS_FEED_URL`, `{ versions: [{ version, released, sunset }] }`);
a version with no published sunset is assumed to expire two years after the next version's
release. Inside 180 days it opens one `[meta-version]` task per workspace with Meta
connections (URGENT inside 30 days). Every response is checked against the pinned version
through `manifest.apiVersionHeader = facebook-api-version`.

## Fixtures

`src/fixtures/*.json` — one recorded-shape payload per kind (secrets scrubbed); golden
snapshots in `src/__snapshots__/`. `src/testing/graph-double.ts` is the Graph API double the
contract suite, the engine's end-to-end test and the seed use.
