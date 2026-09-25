# Keitaro connector

|                          |                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                  | `packages/connectors/keitaro`                                                                                                                                                                                                                                                                                                                             |
| `Platform` enum value(s) | `KEITARO`                                                                                                                                                                                                                                                                                                                                                 |
| API / version pinned     | Keitaro Admin API `v1` (`manifest.apiVersion = 'admin_api/v1'`)                                                                                                                                                                                                                                                                                           |
| Auth kind                | `api_key`                                                                                                                                                                                                                                                                                                                                                 |
| Platform docs            | <https://docs.keitaro.io/>                                                                                                                                                                                                                                                                                                                                |
| Approval / tier required | None — any admin can mint a key under Account → API keys                                                                                                                                                                                                                                                                                                  |
| **Figures verified on**  | **2026-09-25** by this build, against the written spec (§8.6) and Keitaro's public docs site — **no live tracker instance was available to confirm exact endpoint paths/shapes against**; the connector was built and tested against a scripted double, not a real Keitaro deployment (the same caveat Phase 5's Meta connector carries for a real Page). |
| Next re-verification due | 2026-12-24 (≤ 90 days), or before the first real customer connection, whichever comes first                                                                                                                                                                                                                                                               |

## 1. What it is for

Keitaro is the attribution spine: it turns a `subid` click into campaign/source/offer/network
attribution stamped on a Deal, and a `lead → sale → rejected` postback sequence into an exact,
reversible revenue roll-up on that Deal's amount. It deliberately does **not** feed the inbox,
does not create people from clicks, and never attempts IP/user-agent-based identity matching.

## 2. Capabilities

| Capability      | Supported | Requires scope(s) | Degraded when | Notes                                     |
| --------------- | --------- | ----------------- | ------------- | ----------------------------------------- |
| `read:leads`    | yes       | `api_key`         | n/a           | conversions (`lead`/`sale`/`rejected`/…)  |
| `read:insights` | yes       | `api_key`         | n/a           | campaigns/offers/sources, aggregate stats |
| all others      | no        | —                 | —             | read-only, no messaging or publishing     |

Keitaro has no scope-introspection endpoint (a single key grants everything it is scoped to in
the tracker's own admin panel), so `verifyScopes()` always reports nothing missing; a bad key
surfaces as `AUTH_EXPIRED` on the first real call and through `health()`.

## 3. Authentication

- Flow: none. The user creates a key in their Keitaro instance (_Account → API keys_), pastes
  it plus the tracker's base URL into `connection.connectApiKey` (no OAuth redirect exists for
  `authKind: 'api_key'` — `buildAuthUrl`/`exchangeCode` throw `VALIDATION` if ever called).
- The key is sent as an `Api-Key` request header on every call.
- Token lifetime: indefinite. `refresh()` always throws `AUTH_EXPIRED` with the remediation
  "regenerate the key in your Keitaro admin panel and reconnect" — there is no refresh path.
- Account discovery: `discoverAccounts()` returns exactly one synthetic account (the tracker's
  own hostname) — Keitaro is a single self-hosted instance per connection, not a multi-account
  platform.
- Revocation: `revoke()` is a no-op (best-effort; Keitaro has no revoke endpoint) — disconnect
  deletes the vault entry regardless.
- `connectApiKeyPlatform` runs a live `health()` check **before** persisting anything, so a wrong
  key or an unreachable base URL fails the connect call itself rather than the first sync.

## 4. Scopes

| Scope id  | Plain language shown to the user                           | Required for                  | Sensitive |
| --------- | ---------------------------------------------------------- | ----------------------------- | --------- |
| `api_key` | "Read campaigns, offers and conversions from your tracker" | `read:leads`, `read:insights` | yes       |

## 5. Endpoints used

| Endpoint id                          | Method + path                        | Used by               | Cost   | Page size | Notes                                     |
| ------------------------------------ | ------------------------------------ | --------------------- | ------ | --------- | ----------------------------------------- |
| `POST /admin_api/v1/conversions/log` | `POST /admin_api/v1/conversions/log` | `keitaro.conversions` | 1 call | 10        | body-based `{limit, offset, from}` filter |
| `GET /admin_api/v1/campaigns`        | `GET /admin_api/v1/campaigns`        | `keitaro.campaigns`   | 1 call | 10        | slow-changing configuration               |

`keitaro.clicks` has no endpoint wired yet — see §13.

## 6. Resources

| Resource id           | Kinds yielded        | Default interval | Default enabled | Backfill   | Webhook | Cost/page | Lanes                    | Cursor strategy       |
| --------------------- | -------------------- | ---------------- | --------------- | ---------- | ------- | --------- | ------------------------ | --------------------- |
| `keitaro.conversions` | `keitaro_conversion` | 120 s            | yes             | yes        | yes     | 1         | delta, backfill, webhook | offset + 120s overlap |
| `keitaro.campaigns`   | `keitaro_campaign`   | 3600 s           | yes             | yes        | no      | 1         | delta, backfill          | offset                |
| `keitaro.clicks`      | `keitaro_click`      | 900 s            | **no**          | never full | no      | 1         | delta only               | n/a — off by default  |

`keitaro.conversions`: offset-based pagination over `postback_datetime`; the high-water mark is
the newest `postback_datetime` seen. A conversion "disappearing" on the platform never happens —
Keitaro re-sends the same `conversion_id` with a new `status` instead (see §9).

## 7. Webhooks

- Supported: yes. Verification: `shared_secret` — the per-connection secret rides in the
  postback URL's `?key=` query parameter (a Keitaro postback URL is a plain macro-templated URL;
  there is no signing capability to attach a header or sign the body with).
- Topic: conversion postbacks only (`keitaro.conversions`).
- `subscribeWebhooks()` is a no-op — Keitaro has no subscription API; the user pastes the
  postback URL Nexus generates (`connection.connectApiKey`'s response) into their tracker's
  stream/campaign settings by hand.
- Ack budget: same < 200 ms path as every other platform (`receiveWebhook`).
- Replay: not replayable — the `keitaro.conversions` poll is the reconciliation source of truth,
  exactly as the postback is documented to be a hint, not the record.
- `connectionHint`: the connection id is read from the webhook path
  (`/api/webhooks/keitaro/:connectionId`), matching the shared receiver's generic path pattern.

## 8. Quota math

- Shape: `fixed_window`, 10 calls / 5 seconds, 2 concurrent — a steady-state 2 req/s (§8.6's
  conservative default) expressed with headroom for a short burst rather than a rigid
  one-request-per-second gate. This is **our own default, not a platform figure**: Keitaro
  publishes no rate limit at all, because a customer's own server is also serving live traffic.
- `ConnectionSettings.clientLimiter` overrides `requestsPerSecond`/`maxConcurrent` per
  connection (wired generically in `bindConnection`/`provisionalCtx` via `quotaFor()`, ADR-019).
- Worked example: at the default interval, `keitaro.conversions` polls every 120s (720/day) and
  `keitaro.campaigns` every hour (24/day) — 744 calls/day at 1 call/page, far under any
  reasonable client-side cap even at the conservative default.
- No `metered_credits`/`daily_units` math applies — Keitaro is calls-only.

## 9. Messaging-window and content rules

Not applicable — Keitaro has no outbound actions. `preflight()` always returns `POLICY_BLOCKED`
("Keitaro is a read-only attribution source") and `execute()` always throws.

## 10. Failure codes → remediation

| Platform signal                | `FailureClass`  | Behaviour                            | Remediation string                                                  |
| ------------------------------ | --------------- | ------------------------------------ | ------------------------------------------------------------------- |
| HTTP 401 (bad/revoked key)     | `AUTH_EXPIRED`  | pause connection, `health` reconnect | "Regenerate the API key in your Keitaro admin panel and reconnect." |
| Unreachable base URL / timeout | `PLATFORM_DOWN` | circuit opens, `health` down         | "Confirm the tracker base URL is reachable from this server."       |
| HTTP 5xx streak                | `PLATFORM_DOWN` | circuit opens                        | "Keitaro is having problems. Retrying."                             |
| Zod failure in `normalize()`   | `SCHEMA_DRIFT`  | persist raw, quarantine              | "N conversions need attention."                                     |
| `refresh()` ever called        | `AUTH_EXPIRED`  | n/a — never happens in practice      | "Regenerate the API key in your Keitaro admin panel and reconnect." |

## 11. Normalization notes

- One Keitaro conversion → one `CanonicalEntity` of kind `conversion`. `externalId` is
  `conversion_id`; `subid` is the click/join key; `tid` (default `''` if absent) distinguishes
  several conversions on one click.
- `campaign`/`source`/`offer`/`affiliateNetwork`/`stream`/`landing` map to `{externalId, name}`
  pairs (`namedRefSchema`); a null/absent ref normalizes to `null`, never an empty object.
- `sub_id_1..sub_id_30` are read dynamically from the raw payload (whichever the customer's
  tracker populated) rather than a fixed zod list — this is real per-connection variability, not
  drift. Only fields the connection's `subIdMapping` setting declares (email/phone/external CRM
  id/affiliate lead id) feed §10 identity resolution; everything else stays in `raw`.
- `keitaro.campaigns` normalizes to a `metric` canonical kind (`campaign_state`), not a new
  "campaign" kind — a slow-changing configuration dimension, not a person/conversation/post.
- Identity: **no fuzzy-name or IP-based matching, ever.** An anonymous `Identity` keyed on
  `subid` with `platform: KEITARO` and no Person is the default; a later channel event carrying
  the same `subid` (via a mapped sub_id) resolves it retroactively. Not yet wired into a sink —
  see §13.
- Media: n/a — Keitaro has no media objects.

## 12. Per-connection settings that matter here

`baseUrl` (required, HTTPS), `caCertPem` (optional pinned/self-signed cert), `clientLimiter`
(`requestsPerSecond`/`maxConcurrent`, default 2/2), `subIdMapping` (per-`sub_id_N` meaning:
email/phone/external_crm_id/affiliate_lead_id/ignore), `clickFilter` (`convertedOnly` default
`true` — `keitaro.clicks` is off by default regardless), `retentionDays` (should default low —
click-level data is personal data in the EU/UK; see §13).

## 13. Not supported / known gaps

- **`keitaro.clicks` has no `fetchPage` implementation yet** — the resource is declared (so the
  settings UI can show the toggle and its warning) but `fetchPage` throws `VALIDATION` if it is
  ever scheduled; wiring it to `settings.clickFilter` is deferred to Phase 9 alongside the
  broader field-mapping UI.
- **The `sub_id_1..30` → Identity resolution described in §8.6 is normalized but not yet sunk** —
  `normalize()` produces `subIds` on the canonical conversion, and an anonymous `Identity` keyed
  on `subid` is the intended target, but no sink writes it yet (the attribution sink writes only
  to the Deal). Deferred alongside `keitaro.clicks`.
- **`/report/build` (aggregated reports) is not implemented** — campaign-performance widgets are
  Phase 9/11 (Reports) work; this connector only syncs raw dimensions and conversions.
- **No batching (`?batch`/`?bulk`) yet** — each configuration resource fetch is a separate call;
  worth revisiting once real customer volume is known, per §8.6's own note that batching is for
  configuration fetches specifically.
- **Endpoint paths are best-effort, not confirmed against a live Keitaro instance** — see the
  header's verification note.

## 14. Fixture inventory

| File                               | Kind                 | Captured on | What it exercises                                              |
| ---------------------------------- | -------------------- | ----------- | -------------------------------------------------------------- |
| `keitaro_conversion.json`          | `keitaro_conversion` | 2026-09-25  | a `sale` with full attribution, geo, device, creative, sub_ids |
| `keitaro_conversion.rejected.json` | `keitaro_conversion` | 2026-09-25  | the same click's `rejected` postback (reversal path)           |
| `keitaro_conversion.drift.json`    | `keitaro_conversion` | 2026-09-25  | invalid currency length → `SCHEMA_DRIFT`                       |
| `keitaro_campaign.json`            | `keitaro_campaign`   | 2026-09-25  | a slow-changing configuration row                              |

## 15. Verification log

| Date       | Who           | What was checked                                                | Changes made                                                                                             |
| ---------- | ------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-09-25 | Phase 8 build | spec §8.6, Keitaro's public docs site (no live instance access) | Wrote the connector against a scripted double; endpoint paths flagged as best-effort in the header above |
