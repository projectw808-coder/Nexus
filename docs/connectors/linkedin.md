# LinkedIn connector

|                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package                  | `packages/connectors/linkedin`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Platform` enum value(s) | `LINKEDIN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| API / version pinned     | `202609` (`manifest.apiVersion`) — sent as the `LinkedIn-Version` HTTP header on every request, never a URL segment                                                                                                                                                                                                                                                                                                                                                                        |
| Auth kind                | `oauth2` (vanilla 3-legged authorization code — no PKCE requirement is documented for LinkedIn)                                                                                                                                                                                                                                                                                                                                                                                            |
| Platform docs            | <https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-integrations-overview> (`manifest.docsUrl`)                                                                                                                                                                                                                                                                                                                                                                   |
| Approval / tier required | **Member identity needs no review.** Organization content (Community Management API) and Lead Sync additionally require an application approved for **LinkedIn's Marketing Developer Platform** — see §13 and §3.                                                                                                                                                                                                                                                                          |
| **Figures verified on**  | **2026-09-25** by this build, against the written Phase 8 task spec and LinkedIn's publicly documented product shape — **no live LinkedIn Marketing Developer Platform app was available to confirm exact endpoint paths/response shapes, quota figures, or the Lead Sync push-signing scheme against.** Built and tested against a scripted double (`src/testing/linkedin-double.ts`), not a real LinkedIn app. The quota figures in §8 are an explicit placeholder — see the note there. |
| Next re-verification due | 2026-12-24 (≤ 90 days), or before the first real customer connection, whichever comes first                                                                                                                                                                                                                                                                                                                                                                                                |

## 1. What it is for

This connector feeds the timeline (organization posts and their comments) and the leads
pipeline (Lead Gen Form submissions via Lead Sync) from a LinkedIn organization page the
connected member administers. It deliberately does **not** support any outbound action —
`preflight`/`execute` always refuse — and it does **not** model messaging of any kind:
member-to-member DMs are not available on LinkedIn's public API, full stop, and this connector
never promises them anywhere (no `read:messages`/`write:reply_dm` capability, no DM resource).

## 2. Capabilities

| Capability       | Supported | Requires scope(s)                                | Degraded when                                        | Notes                                             |
| ---------------- | --------- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------- |
| `read:posts`     | yes       | `r_organization_social`, `rw_organization_admin` | either scope missing → organization posts not synced | Community Management API                          |
| `read:comments`  | yes       | `r_organization_social`, `rw_organization_admin` | either scope missing → comments not synced           | Community Management API                          |
| `read:leads`     | yes       | `r_marketing_leadgen_automation`                 | scope missing → Lead Sync/leads not synced           | requires Marketing Developer Platform approval    |
| `read:messages`  | no        | —                                                | —                                                    | **not available on LinkedIn's API — never build** |
| `write:reply_dm` | no        | —                                                | —                                                    | **not available on LinkedIn's API — never build** |
| `write:*` (all)  | no        | —                                                | —                                                    | read-only connector this phase                    |

## 3. Authentication

- Flow: standard OAuth 2.0 authorization code, 3-legged, no PKCE (`buildAuthUrl` uses the SDK's
  generic `buildAuthorizationUrl`; `exchangeCode`/`refresh`/`revoke` use the generic
  `exchangeAuthorizationCode`/`refreshAccessToken`/`revokeToken` helpers — LinkedIn's flow needs
  nothing platform-specific beyond the endpoint URLs).
  - Authorize: `GET /oauth/v2/authorization`
  - Token: `POST /oauth/v2/accessToken`
  - Revoke: `POST /oauth/v2/revoke`
- Redirect URI: the deployment's standard OAuth callback (`ctx.redirectUri`), registered with the
  LinkedIn app in the Developer Portal.
- Token lifetime: LinkedIn access tokens are typically long-lived (~60 days) with a refresh
  token; `refresh()` delegates to the generic `refreshAccessToken` helper, which throws
  `AUTH_EXPIRED` if no refresh token is on file, prompting re-authorization.
- Account discovery: `discoverAccounts()` calls `GET /rest/organizationAcls?q=roleAssignee` and
  returns one `DiscoveredAccount` per organization where the member holds an `ADMINISTRATOR`
  role in `APPROVED` state — the same member token is reused for every organization (LinkedIn
  has no per-organization token exchange analogous to Meta Page tokens, so `hasOwnToken: false`
  on every discovered account). Each becomes its own `Connection`, the same fan-out pattern the
  Meta connector uses for Pages.
- Revocation: `revoke()` calls `POST /oauth/v2/revoke`; best-effort like every connector — the
  vault entry is deleted regardless of the platform-side outcome.

## 4. Scopes

| Scope id                         | Plain language shown to the user                              | Required for                             | Sensitive (review needed) |
| -------------------------------- | ------------------------------------------------------------- | ---------------------------------------- | ------------------------- |
| `openid`                         | "Confirm who you are on LinkedIn"                             | —                                        | no                        |
| `profile`                        | "See your name and profile picture"                           | —                                        | no                        |
| `email`                          | "See your email address"                                      | —                                        | no                        |
| `r_organization_social`          | "Read your organization pages' posts, comments and reactions" | `read:posts`, `read:comments`            | yes                       |
| `w_organization_social`          | "Post and comment as your organization pages"                 | — (no write capability built this phase) | yes                       |
| `rw_organization_admin`          | "See which organization pages you administer"                 | `read:posts`, `read:comments`            | yes                       |
| `r_ads`                          | "Read your ad accounts and campaigns"                         | —                                        | yes                       |
| `r_marketing_leadgen_automation` | "Read leads submitted through your Lead Gen Forms"            | `read:leads`                             | yes                       |

**Retired — never request:** `r_liteprofile` and `r_emailaddress` were retired by LinkedIn in 2023. `openid`/`profile`/`email` (LinkedIn's OIDC "Sign In with LinkedIn v2") are their
replacements for member identity and are what this connector requests instead.

Matches `manifest.scopes` exactly (`packages/connectors/linkedin/src/manifest.ts`).

## 5. Endpoints used

| Endpoint id                                  | Method + path                            | Used by (resource / action)      | Cost (units / credits / calls) | Page size    | Notes                                                                 |
| -------------------------------------------- | ---------------------------------------- | -------------------------------- | ------------------------------ | ------------ | --------------------------------------------------------------------- |
| `GET /oauth/v2/authorization`                | `GET /oauth/v2/authorization`            | auth: `buildAuthUrl`             | n/a                            | —            | browser redirect, not a budgeted call                                 |
| `oauth.token` (`POST /oauth/v2/accessToken`) | `POST /oauth/v2/accessToken`             | auth: `exchangeCode`/`refresh`   | n/a                            | —            | not budgeted (auth-only endpoint)                                     |
| `oauth.revoke` (`POST /oauth/v2/revoke`)     | `POST /oauth/v2/revoke`                  | auth: `revoke`                   | n/a                            | —            | best-effort, not budgeted                                             |
| `GET /rest/organizationAcls`                 | `GET /rest/organizationAcls`             | `discoverAccounts`               | 1 call                         | —            | filtered client-side to `ADMINISTRATOR` + `APPROVED`                  |
| `GET /rest/posts`                            | `GET /rest/posts`                        | `li.posts`                       | 1 call                         | 10 (default) | `start`/`count` offset pagination, filtered by `author`               |
| `GET /rest/organizationalEntityComments`     | `GET /rest/organizationalEntityComments` | `li.comments`                    | 1 call                         | 10 (default) | `start`/`count` offset pagination, filtered by `organizationalEntity` |
| `GET /rest/leadFormResponses`                | `GET /rest/leadFormResponses`            | `li.leads`                       | 1 call                         | 10 (default) | `start`/`count` offset pagination, filtered by `owner`                |
| `POST /rest/leadNotifications`               | `POST /rest/leadNotifications`           | `subscribeWebhooks` (`li.leads`) | 1 call                         | —            | idempotent registration of the Lead Sync push destination             |
| `GET /v2/userinfo`                           | `GET /v2/userinfo`                       | `health()` reachability check    | 1 call (lightweight)           | —            | standard OIDC userinfo endpoint                                       |

Every call sets `LinkedIn-Version: <manifest.apiVersion>` as a header (never a URL segment) —
verified directly in `connector.test.ts` ("sends the pinned LinkedIn-Version header...").

## 6. Resources

| Resource id   | Kinds yielded | Default interval | Default enabled | Backfill | Webhook | Cost / page | Lanes                    | Cursor strategy        |
| ------------- | ------------- | ---------------- | --------------- | -------- | ------- | ----------- | ------------------------ | ---------------------- |
| `li.posts`    | `li_post`     | 900 s            | yes             | yes      | no      | 1           | delta, backfill          | `start`/`count` offset |
| `li.comments` | `li_comment`  | 900 s            | yes             | yes      | no      | 1           | delta, backfill          | `start`/`count` offset |
| `li.leads`    | `li_lead`     | 900 s            | yes             | yes      | yes     | 1           | delta, backfill, webhook | `start`/`count` offset |

For all three resources, pagination is LinkedIn's typical `start`/`count` offset shape: the
connector's opaque `nextCursor` is simply the next `start` value as a decimal string, and
`null` once `start + returned count >= paging.total`. The high-water mark is the newest
`createdAt`/`created`/`submittedAt` millisecond timestamp seen in the page (LinkedIn returns
epoch-millisecond integers, not ISO strings, for these fields). `overlapSeconds: 120` is
requeried on every delta poll to cover clock skew and late-arriving writes, same as Keitaro's
conversions resource. A post or comment removed on LinkedIn's side is not distinguishable from
one that was never returned by the API (there is no tombstone signal in the endpoints modelled
here) — it simply stops appearing in subsequent pages.

## 7. Webhooks

- Supported: yes, for `li.leads` only (`webhooks.resources: ['li.leads']`).
- Verification scheme: **`shared_secret`** — chosen because confident public documentation of
  LinkedIn Lead Sync's exact push-signing scheme was not available while building this
  connector. `verifyWebhook()` compares an `x-li-verification-token` request header against the
  connection's stored webhook secret via the SDK's `verifySharedSecret`. **This needs
  re-verification against a real LinkedIn Marketing Developer Platform app** before going live:
  confirm the actual header/query field LinkedIn uses to carry the verification token, and
  whether LinkedIn in fact offers a genuine HMAC-over-body scheme instead (if so, switch to
  `verifyHmacSha256` and update `manifest.webhooks.verification`). Until then, this connector
  does **not** claim HMAC support it cannot back up.
- Because `shared_secret` only proves the sender knows the token — not that the body was
  untampered — the contract test suite's universal webhook tamper-rejection check does not
  apply to it (the same reasoning the Keitaro connector documents for its own `shared_secret`
  webhook). `connector.test.ts` omits `spec.webhook` from `defineConnectorContract` and verifies
  `verifyWebhook`/`parseWebhook` directly instead.
- Topics: a single Lead Sync notification per new lead, feeding `li.leads`.
- Handshake: not modelled — `parseWebhook()` returns `[]` for any body that doesn't match the
  expected `{ leadId, formId?, owner? }` shape (a safe default for a ping/challenge request).
- Ack budget: the platform's own <200ms delivery-ack budget applies; `verifyWebhook`/
  `parseWebhook` are synchronous and side-effect free, per the SPI contract.
- Replay: `replayable: false` — LinkedIn does not document a way to re-request a missed Lead
  Sync delivery, so `li.leads` keeps its 900s reconciliation poll regardless of webhook
  approval (spec §9.1: a webhook is a hint, never a replacement for the poll).
- `connectionHint` extraction: `parseWebhook()` reads the connection id from the webhook path
  segment (`/webhooks/linkedin/:connectionId`, same convention as every other connector) and the
  `accountExternalId` from the payload's `owner` (organization URN) field.

## 8. Quota math

- Shape: `fixed_window` — `{ windowSeconds: 86400, limit: 100000 }`.
- **This is a conservative PLACEHOLDER, not a verified platform figure.** LinkedIn does not
  publish one clean cross-product rate-limit number: real limits are per-app-per-day, vary by
  API product (Community Management, Marketing Developer Platform, Lead Sync) and by approval
  tier, and are only visible per-app in LinkedIn's Developer Portal once an app is provisioned.
  **Re-verify against the customer's actual approved throughput in the Developer Portal for
  their specific product tier before relying on this number in production**, and update
  `manifest.quota` accordingly.
- No response headers are asserted for observed usage beyond the SDK's generic
  `observedFromHeaders` (`x-rate-limit-remaining`/`x-rate-limit-limit`/`retry-after` families) —
  no LinkedIn-specific usage header convention is confirmed, so nothing platform-specific is
  hard-coded here.
- Worked example (illustrative only, given the placeholder limit): a single organization with
  posts polled every 900s (96 polls/day), comments every 900s (96 polls/day) and leads every
  900s (96 polls/day) costs roughly 288 calls/day of the placeholder 100,000/day budget — trivial
  headroom at this placeholder, which is exactly why it must be re-verified rather than trusted.
- Back-off threshold: none platform-specific configured; the generic `RATE_LIMITED` → breaker →
  retry-after path applies uniformly.

## 9. Messaging-window and content rules

Not applicable — this connector has no outbound actions and no messaging capability.
`preflight()` unconditionally returns `{ ok: false, code: 'POLICY_BLOCKED', reason: 'LinkedIn is
read-only in this connector' }` for every action kind, and `execute()` unconditionally throws
`POLICY_BLOCKED`. There is no `replyWindowExpiresAt` concept here because no conversation
resource is modelled.

## 10. Failure codes → remediation

| Platform signal                                                                                                   | `FailureClass`                                                  | Behaviour                                                                                 | Remediation string (verbatim, as shown in UI)                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401 (invalid/expired access token)                                                                           | `AUTH_EXPIRED`                                                  | pause connection, prompt reconnect                                                        | (generic OAuth remediation from `classifyOauthError`/`classifyHttpStatus`) "Reconnect LinkedIn — your access expired."                                                                              |
| HTTP 403 (insufficient scope)                                                                                     | `SCOPE_MISSING`                                                 | disable the affected capability only                                                      | surfaced via `verifyScopes()`/`health()`'s `approval` check: "Apply for LinkedIn Marketing Developer Platform access — organization posts, comments and Lead Sync stay unavailable until approved." |
| HTTP 429                                                                                                          | `RATE_LIMITED`                                                  | back off per `Retry-After`, keep interactive lane                                         | "Syncing slowly — LinkedIn's rate limit was hit, resumes {time}."                                                                                                                                   |
| HTTP 5xx / transport failure / timeout                                                                            | `PLATFORM_DOWN`                                                 | circuit breaker opens, retried                                                            | "LinkedIn is having problems. Retrying."                                                                                                                                                            |
| Zod `.strict()` failure in `normalize()`                                                                          | `SCHEMA_DRIFT`                                                  | raw persisted, item quarantined                                                           | "3 items need attention."                                                                                                                                                                           |
| Org/Lead-Sync scopes missing (`r_organization_social`, `rw_organization_admin`, `r_marketing_leadgen_automation`) | `SCOPE_MISSING` (via degraded capabilities, not a hard failure) | connection stays healthy-but-`degraded`, exactly the three affected capabilities disabled | "Apply for LinkedIn Marketing Developer Platform access — organization posts, comments and Lead Sync stay unavailable until approved."                                                              |
| Outbound action attempted (any kind)                                                                              | `POLICY_BLOCKED`                                                | refused before enqueue                                                                    | "LinkedIn is read-only in this connector." / "There is nothing to send on a LinkedIn connection."                                                                                                   |

## 11. Normalization notes

- `li_post` → one `CanonicalPost`: `postType: 'original'` always (no repost/reply modelling this
  phase), `mediaType` derived from the raw `contentType` enum (`IMAGE`→`image`, `VIDEO`→`video`,
  `CAROUSEL`→`carousel`, `ARTICLE`→`link`, `DOCUMENT`→`other`, `NONE`→`text`), `body` from
  `commentary`, `stats.{likes,comments,shares,views}` from `totalSocialActivityCounts` when
  present, `authorExternalId` the organization URN, `sourceUrl` a `linkedin.com/feed/update/...`
  deep link.
- `li_comment` → one `CanonicalMessage` (`messageType: 'comment'`), threaded via
  `parentExternalId`/`rootExternalId` (the parent comment URN and the post URN, respectively),
  `conversationExternalId: 'post:<postUrn>'`, `direction` computed against
  `ctx.accountExternalId`. **Design decision:** this connector does **not** additionally mint a
  `CanonicalEngagement` per reaction. LinkedIn's Community Management API surfaces reactions only
  as the aggregate counts already captured in the parent post's `stats.likes` — not as a
  per-actor reaction feed this connector fetches — so there is nothing per-reaction to normalize
  this phase. A future phase could add a `li.reactions` resource and a
  `CanonicalEngagement(engagementType: 'reaction')` mapping if LinkedIn exposes a per-actor feed.
- `li_lead` → one `CanonicalLead` (`source: 'lead_form'`). LinkedIn Lead Sync has no stable
  field-name schema across forms, so typed fields are extracted by matching each answer's
  human-readable `question` label case-insensitively (`"First Name"`/`"Last Name"`/`"Full
Name"` → `fullName`; `"Email"`/`"Email Address"`/`"Work Email"` → `email`, validated against a
  basic email shape before being set; `"Phone Number"`/`"Phone"`/`"Mobile Phone Number"` →
  `phone`, validated as E.164 before being set; `"Company Name"`/`"Company"` → `companyName`).
  Every answer, matched or not, is preserved verbatim in `fields[]`; `campaignExternalId` comes
  from the raw `campaign` URN when present; `consent.marketing` from `consentToMarketing`.
- Identity: email/phone extracted from lead answers are Tier-1 signals per §10 when they pass
  format validation; nothing else on this connector (post/comment author URNs) is treated as an
  identity-matching signal — they are opaque LinkedIn ids used only for attribution within the
  platform's own object graph.
- Handle-change detection: not applicable — organizations are identified by their stable URN,
  and no person-level handle is modelled by this connector.
- Media: post `media: []` always this phase — the raw shapes captured here (`li_post`) do not
  yet include the underlying image/video/document asset URNs; a future phase would extend
  `rawPostSchema` and map them into `Attachment`s.

## 12. Per-connection settings that matter here

- `accountExternalId`: the organization URN (`urn:li:organization:<id>`) returned by
  `discoverAccounts()` — every `li.posts`/`li.comments`/`li.leads` call is filtered to this
  organization.
- No connector-specific `ConnectionSettings` fields are read this phase (no `baseUrl`,
  `retentionDays` override, `spendCap`, or sub-id mapping needed — LinkedIn's origin is fixed and
  there is no metered-credits quota to cap).

## 13. Not supported / known gaps

- **Member-to-member DMs are not available on LinkedIn's public API and are never modelled
  here** — no `read:messages`/`write:reply_dm` capability, no DM resource, and this is called
  out explicitly in the manifest's `constraints` so it can't be silently promised later.
- **Organization content and Lead Sync require LinkedIn Marketing Developer Platform approval.**
  Until an app is approved, a connection still connects successfully with member-only identity;
  `read:posts`, `read:comments` and `read:leads` are reported as degraded by `verifyScopes()`,
  and `health()` reports `status: 'degraded'` (never `'down'`) with an `approval` check carrying
  the remediation "Apply for LinkedIn Marketing Developer Platform access — organization posts,
  comments and Lead Sync stay unavailable until approved." This is treated as an expected,
  first-class connection state, not an error.
- **No outbound actions this phase** — `preflight`/`execute` always refuse with
  `POLICY_BLOCKED`, matching the read-only pattern the Keitaro connector also uses.
- **`r_liteprofile`/`r_emailaddress` are never requested** — they were retired by LinkedIn in
  2023; `openid`/`profile`/`email` are used instead.
- **No served-API-version drift check** — `manifest.apiVersionHeader` is deliberately left unset
  because there is no confirmed evidence LinkedIn echoes its served version back in a response
  header; asserting one would be an unverified claim.
- **Quota figures are a placeholder** (§8) pending a real approved app's Developer Portal limits.
- **No reaction-level engagement feed** (§11) — only aggregate like/comment/share/view counts on
  the post are captured.
- **No media attachments on posts** (§11) — `media: []` always this phase.

## 14. Fixture inventory

| File                 | Kind         | Captured from API version | Captured on | What it exercises                                                                                                    |
| -------------------- | ------------ | ------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `li_post.json`       | `li_post`    | `202609` (double)         | 2026-09-25  | a normal published organization post with engagement stats                                                           |
| `li_comment.json`    | `li_comment` | `202609` (double)         | 2026-09-25  | a top-level comment on that post → `CanonicalMessage` threading                                                      |
| `li_lead.json`       | `li_lead`    | `202609` (double)         | 2026-09-25  | a Lead Gen Form submission → typed `fullName`/`email`/`phone`/`companyName` extraction from labeled answers          |
| `li_post.drift.json` | `li_post`    | `202609` (double)         | 2026-09-25  | an unrecognized `distribution` field LinkedIn hasn't sent before → `.strict()` rejection → `SCHEMA_DRIFT` quarantine |

All four fixtures are recorded/synthetic against the scripted double in
`src/testing/linkedin-double.ts` (no live LinkedIn app was available — see the header table).

## 15. Verification log

| Date       | Who           | What was checked                                                                                                                                                                                                                                                                                     | Changes made                                                                              |
| ---------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 2026-09-25 | Phase 8 build | Manifest shape against `@nexus/connector-sdk`'s schema; scopes/capabilities wiring; quota shape chosen as a documented placeholder; webhook verification scheme chosen as `shared_secret` pending re-verification; contract suite + connector-specific tests all passing against the scripted double | Initial connector built end-to-end; this sheet replaces the `new-connector` TODO scaffold |
