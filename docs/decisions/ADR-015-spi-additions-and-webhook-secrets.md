# ADR-015 — Additions to the connector SPI and per-connection webhook secrets in the path

**Status:** accepted (Phase 4) · **Spec:** §5.4 webhooks, §7.1 SPI, §11.3 receiver

## Context

Implementing the mock connector against the §7.1 interface surfaced three gaps: the auth
methods had no HTTP client (a connector would have had to call `fetch` directly, which the
lint rule forbids), a connector had no way to learn its per-connection webhook secret at
subscription time, and the receiver had no rule for which secret verifies an inbound request.

## Decision

Additive changes only; every §7.1 method keeps its signature.

- `AuthCtx.http: HttpClient` — core-injected client for token endpoints, with the same retries,
  breaker and tracing as data calls.
- `ConnCtx.webhookSecret(): Promise<string | null>` — the per-connection verify secret from the
  vault, for connectors that register it with the platform on `subscribeWebhooks`.
- `HttpRequest.endpoint` / `HttpRequest.signal` and `HttpResponse.attempts` — endpoint ids for
  the breaker and budget windows, per-request cancellation, and the attempt count.
- `BudgetReservation.resourceKey` carries the metered-credits dedup key from reserve to settle.
- Webhook secret resolution in the receiver: a connection id in the path
  (`/api/webhooks/<platform>/<connectionId>`) selects that connection's vault secret;
  otherwise the platform's app-level secret from the environment (Meta's app secret). A request
  that verifies with neither is logged with `verified: false` and answered 401.

## Consequences

- The SDK's `createTestConnCtx` / `createTestAuthCtx` and the contract suite cover the new
  fields, so every connector gets them for free.
- Keitaro-style per-connection secrets and Meta-style app secrets use the same receiver.
