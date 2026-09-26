# ADR-022 — REST v1's transport, the consent gate's scope, and outbound webhooks' event source

**Status:** accepted (Phase 11) · **Spec:** §5.5, §11.2, §12.4, §16 Phase 11 · **Builds on:** ADR-006, ADR-014, ADR-021

## Context

Phase 11 is the last phase: a public REST API generating a real OpenAPI 3.1 client, customer-facing
outbound webhooks, DSAR export/erasure, retention purge, consent gates, and a dashboard builder
whose charts obey §12.4's binding rules. Three things needed a decision before writing code.

## Decisions

1. **REST v1 is hand-written Next.js route handlers over the existing `@nexus/db`/`@nexus/sync`
   functions, not a tRPC-to-REST bridge.** Every tRPC procedure already resolves its actor from a
   _session_ (`tenantProcedure` needs `ctx.slug` + `ctx.session.id` to call
   `tenancy.resolveActor`). REST v1 authenticates with a workspace API key instead — the key
   itself fixes the workspace, so there is no slug in the URL at all
   (`GET /v1/objects/:slug/records` — `:slug` there is the _object's_ slug, e.g. `widget`, never
   the workspace's). Retrofitting a session-shaped middleware to also accept a bearer key is
   more fragile than a second, thin transport that resolves `{workspaceId, actor}` from the key
   and calls the same underlying functions the tRPC routers already call — record CRUD, list
   entries, timeline, conversations, connections all go through the identical `@nexus/db` /
   `@nexus/sync` functions either way, so there is no duplicated business logic, only a
   duplicated (and much thinner) auth/routing layer.
2. **OpenAPI 3.1 is generated from the same Zod schemas that validate each route**, via a small
   registry (`packages/api`) built on `@asteasolutions/zod-to-openapi` — a schema-to-document
   converter with no opinion about routing or auth, unlike a tRPC-to-OpenAPI bridge, which would
   fight decision 1. The acceptance criterion ("the OpenAPI spec generates a working client") is
   verified literally: `openapi-typescript` generates a typed client from the served
   `/v1/openapi.json`, and a test calls a real endpoint through it.
3. **The consent gate (§5.5 "block outbound sends where consent is absent or withdrawn") applies
   to workflow-triggered sends, not to a human replying to a specific inbound message.** A
   support reply to an inbound DM is a transactional response to something the customer just
   said — it is not what GDPR/CAN-SPAM mean by "marketing," and gating it on a `ConsentRecord`
   that will be `UNKNOWN` for the overwhelming majority of identities would make the unified
   inbox unusable. Nexus has no bulk/marketing-campaign feature to gate either. The one place an
   _unprompted_ outbound send genuinely exists is `@nexus/automation`'s `send_reply`/`send_email`
   actions (Phase 10) — a workflow firing on its own trigger, not a human answering a specific
   message. `ConsentRecord` (one row per `(identity, channel)`, `UNKNOWN | GRANTED | WITHDRAWN`)
   is checked there: `WITHDRAWN` blocks the step outright; `UNKNOWN` and `GRANTED` both proceed
   (spec's "absent" reading — treating the overwhelmingly common default as a block would be
   unusable — is interpreted as "absent from an explicit allowlist-only channel," which this
   product does not have; `WITHDRAWN` is the signal that actually exists and actually matters).
   The gate is still visible and manageable: a Consent tab shows every identity's status per
   channel and lets someone record a withdrawal by hand.
4. **Outbound webhook delivery reuses the same event data stage 6 (ADR-021) already computes,
   rather than re-deriving "what happened" a second time.** `packages/sync/src/react.ts`'s
   per-`TimelineEvent` loop and the record/list mutation call sites in `apps/web` already turn a
   materialized change into a typed event; right alongside the existing `automate.react` dispatch,
   the same call site now also calls `dispatchOutboundWebhookEvent(db, bus, {workspaceId,
eventType, payload})`, which matches `OutboundWebhookSubscription.events` and enqueues one
   signed delivery per matching subscription. This is a second consumer of the same "an event
   happened here" call sites Phase 10 already established, not a new event-detection mechanism.

## Consequences

`packages/api` is a new package (OpenAPI schema registry only — no route handlers, no auth,
matching decision 2's scope). REST v1 route handlers live in `apps/web/app/api/v1/**` and depend
on `@nexus/db`/`@nexus/sync` exactly as the tRPC routers do, so the two transports can never
silently diverge in what they allow. The consent gate does not touch the composer or
`requestReply`'s existing preflight at all — a human can always reply to an inbound message
regardless of consent status, which is the correct behavior, not a gap.
