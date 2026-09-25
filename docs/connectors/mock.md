# Mock platform connector

The mock platform is the reference connector and the target of every pipeline test, the seed
and the throughput benchmark (spec §16 Phase 4). It is a deterministic fake social platform:
accounts own posts, posts have comments. It runs in-process as a `fetch` implementation
(`https://mock.platform.local`) or over HTTP (`platform.listen()` → `http://127.0.0.1:<port>`).

Package: `packages/connectors/mock` (`@nexus/connector-mock`). Registry: `MOCK`.

## Endpoints used

| Purpose                  | Endpoint                                            | Cost |
| ------------------------ | --------------------------------------------------- | ---- |
| Token exchange / refresh | `POST /oauth/token`                                 | none |
| Revoke                   | `POST /oauth/revoke`                                | none |
| Discover accounts        | `GET /v1/accounts`                                  | 1    |
| Posts page               | `GET /v1/accounts/:id/posts?cursor&limit&since`     | 1    |
| Comments page            | `GET /v1/accounts/:id/comments?cursor&limit&since`  | 1    |
| Reply to a comment       | `POST /v1/comments/:id/replies` (`Idempotency-Key`) | 1    |
| Subscribe webhooks       | `POST /v1/webhooks/subscribe`                       | 1    |
| Health                   | `GET /v1/health`                                    | none |

Pages are at most 500 items; the cursor is an opaque offset token. `since` filters by
`createdAt`. Every authenticated response carries `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset` and `x-mock-api-version`.

## Scopes

| Scope                 | Plain language                           | Required for                      |
| --------------------- | ---------------------------------------- | --------------------------------- |
| `read:posts`          | See the posts published by your accounts | `read:posts`                      |
| `read:comments`       | See comments people leave on your posts  | `read:comments`                   |
| `write:reply_comment` | Reply to comments as your account        | `write:reply_comment` (sensitive) |

Auth kind: `oauth2_pkce`. Codes look like `code-<accountId>`; the token endpoint requires the
PKCE verifier and rejects unknown codes and revoked refresh tokens with `invalid_grant`.

## Quota

Fixed window: 1,000 calls per 15 minutes per token, enforced by the platform with standard
headers, which the connector settles into the budget (`source: observed-header`).

## Webhooks

`comment.created` and `post.created`, signed `x-mock-signature: sha256=<hmac>` with the
per-account secret registered on subscribe (falling back to the platform default), delivery id
in `x-mock-delivery`. Routed by the connection id in the path
(`/api/webhooks/mock/<connectionId>`) or the `accountId` in the body.

## Fault injection

`createMockPlatform({ faults })`: `latencyMs`, `rate429`, `rate5xx`, `schemaDriftRate`
(renames `body` → `content` and breaks `createdAt`), `dropWebhookRate`, `retryAfterSeconds`.
All draws come from a seeded PRNG, so a given seed reproduces the same sequence.

## Failure codes → remediation

| Platform response        | Class         | What the user sees                                                  |
| ------------------------ | ------------- | ------------------------------------------------------------------- |
| 401 `invalid_token`      | AUTH_EXPIRED  | Reconnect Mock Platform — your access expired                       |
| 403 `insufficient_scope` | SCOPE_MISSING | Comment replies need `write:reply_comment`. Re-authorize to enable. |
| 429 (+ `retry-after`)    | RATE_LIMITED  | Syncing slowly — resumes at …                                       |
| 503                      | PLATFORM_DOWN | Mock Platform is having problems. Retrying.                         |
| drifted item             | SCHEMA_DRIFT  | N items need attention + raw viewer                                 |

## Fixtures

- `src/fixtures/mock_post.json`, `src/fixtures/mock_comment.json` — golden inputs for
  `normalize()`; snapshots in `src/__snapshots__/`.
- `src/connector.test.ts` runs the SDK contract suite plus mock-specific behaviour.
