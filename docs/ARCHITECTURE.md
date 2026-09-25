# Nexus — architecture restatement (Phase 0)

_Written before the first line of Phase 0 code, as §21 asks. One page. Disagreements and
deviations are flagged at the end and each one has an ADR._

## What we are building

A multi-tenant CRM whose primary object is a **person resolved across channels**, not a contact
row. Every platform (Facebook, Instagram, X, LinkedIn, TikTok, YouTube, Google, Keitaro) is a
**Connection**: independently authenticated, budgeted, permissioned, pausable, and versioned. All
of them feed one **object graph** (runtime-definable ObjectTypes/Attributes/Records with system
Person/Company/Deal), one **timeline** with provenance, and one **inbox**. Attribution from the
customer's own Keitaro tracker is the first entry on a person's history and the revenue spine of
a Deal.

## The shape

```
browser ──HTTP/SSE──▶ apps/web (Next.js App Router)
                        RSC reads · server actions · tRPC · REST v1 · /api/webhooks/* (ack <200ms)
                        │ enqueue (trace context on the job)          │ read/write via withTenant()
                        ▼                                              ▼
                  Redis 7 / BullMQ  ◀── cursors, budgets ──  PostgreSQL 16 (+pgvector, pg_trgm, citext)
                        │ queues: sync.backfill · sync.delta · ingest.raw · normalize · resolve ·
                        │         automate · ai.enrich · outbound · system
                        ▼
                  apps/worker (processors)  ──▶  packages/connectors/* (SPI)  ──▶  platform APIs
                        ▲ token vault · rate budget · circuit breaker live in connectors/sdk
```

**Seven-stage pipeline** (acquire → persist raw → normalize → resolve → materialize → react →
notify). Connectors implement only stages 1–2 plus a pure `normalize()`. Stage 2 writes
`ExternalObject.raw` **before any interpretation**, so stages 3–7 are replayable per object and
per connection without re-fetching. Stage 5 does not wait for stage 4: rows attach to an
`Identity` immediately and to a `Record` when resolution lands (ADR-003).

**Tenancy is structural.** Every tenant row carries `workspaceId`. Data access goes only through
`withTenant(actor, fn)`, which opens a transaction, issues `SET LOCAL app.workspace_id`, and
hands the callback a Prisma client extension that injects/asserts `workspaceId` on every
operation (including nested relations, `createMany`, `upsert`, aggregates). RLS is the belt, the
scoped client is the braces, and `TENANT_MODELS` is generated from the DMMF so a new model cannot
be forgotten. `basePrisma` is importable only in `packages/db` and `apps/worker/src/system`,
enforced by an ESLint rule.

**Failure is typed.** Every external call returns `Result<T, NexusError>`; every `NexusError` has
a `FailureClass` from the §9.2 taxonomy, which fixes the engine behaviour (pause connection,
disable capability, back off, halt until reset, open circuit, quarantine, block at preflight,
no-op) and the sentence the UI shows. Connectors classify; they do not invent messages.

**Budget before call.** The SDK's `RateLimiter` serves four quota shapes (fixed window, rolling
hour, daily units + capped endpoints, metered credits with a 24h dedup ledger). Every platform
call reserves, calls, then settles with the platform's observed headers, which always beat the
manifest's published numbers. Four lanes (interactive > webhook > delta > backfill) are BullMQ
priorities inside each queue, so a rep's reply never waits behind a backfill.

**Observability is one trace.** Web and worker start the same OpenTelemetry SDK. The HTTP server
span's context is injected into the job payload and extracted by the processor, so
request → queue → connector HTTP call is a single trace, and every pino line carries
`trace_id`, `workspaceId`, `connectionId`.

## Where I deviate or disagree (each has an ADR)

1. **`TimelineEvent.recordId` must be nullable.** §6.6(2) says it "stays non-nullable" while
   §6.6(3) says events attach to an Identity first and to a Record only once resolved. The two
   cannot both hold. Nullable `recordId` + nullable `identityId` with an index on each, and the
   merge snapshot still makes unmerge exact. → ADR-003.
2. **A `packages/telemetry` package**, not in the §3 layout. Logging and tracing are shared by
   web and worker and are not domain (`core`) or configuration (`config`). Adding a package is
   not substituting one. → ADR-004.
3. **Lanes are priorities, not queues.** §4 names queues by pipeline stage and §7.3 names lanes
   by urgency. One worker pool per queue with lane priorities is simpler to reason about than a
   queue per (stage × lane), and BullMQ priorities give strict ordering. → ADR-005.
4. **Jaeger is in `docker-compose`.** §16 Phase 0 lists Postgres, Redis, MinIO, Mailpit, but its
   acceptance check needs a trace backend to be "visible end to end". Jaeger v2 speaks OTLP
   natively; the apps only know an OTLP endpoint, so any collector can replace it.
5. **Prisma 7.** The spec was written against Prisma's classic client. Prisma 7 requires a driver
   adapter (`@prisma/adapter-pg`) and moves the datasource URL to `prisma.config.ts`; `$extends`
   still exists, so the scoped client design stands. Interactive transactions + `SET LOCAL` work
   with the pg adapter.
6. **TypeScript 5.9, not 7.** npm's `latest` is now the Go-based TypeScript 7. The spec locks 5.x
   and the ecosystem (typescript-eslint, Next) is pinned to `<6.1`, so 5.9.3 it is.
7. **Auth.js.** The `next-auth` stable tag is still v4 (Pages-era); Auth.js for the App Router is
   `next-auth@5` (beta channel). Phase 1 will use v5, and this is flagged now because "beta" on the
   auth boundary is a risk the owner should know about.
8. **Custom ESLint rules ship in Phase 0**, not Phase 1. They are small, and a CI skeleton that
   does not enforce §0.4/§5.3 from commit one invites the very bypasses the spec bans.
9. **`Record.embedding` duplicates `Embedding`.** §6.2 puts a `vector(1536)` on Record and §6.5
   defines a chunked `Embedding` table. Both are in the schema as written; Phase 10 should keep
   one (the table, which handles chunking) and this will be revisited then.
10. **The 2,000 objects/min/worker backfill budget is a pipeline number, not a platform number.**
    Agreed, and it is measured only against the mock platform; against YouTube's 10k units/day the
    honest behaviour is a slow, correct ETA.

11. **`seedSystemObjects` became idempotent by upsert instead of the workspace-level short-circuit
    it started as.** A workspace seeded before a later phase adds a new system attribute (Phase
    8's Deal attribution fields) needs a path to get it without a bespoke backfill migration for
    every future addition; upserting by natural key on every `ensureSystemObjects` call gives
    that for free and keeps the existing "seed once" behaviour for a workspace whose
    `SYSTEM_OBJECTS` hasn't grown. → ADR-019.
12. **`connectApiKeyPlatform` takes an already-open `db` instead of opening its own transaction**,
    unlike `connectPlatform` — it is called from a tRPC mutation whose `tenantProcedure` already
    wraps the request in one transaction, and PGlite's single connection deadlocks on a nested
    `withTenant`. `connectPlatform` stays as it was because its only caller (the OAuth callback
    route) has no open transaction to nest inside. → ADR-019.

## Things I checked rather than assumed

- YouTube `search.list` really does sit in its own 100-calls/day bucket independent of units; the
  YouTube connector tracks both, and refuses `search.list` outside the `interactive` lane (Phase 8,
  ADR-019).
- Meta's expired-version fallback is silent; the served-version assertion on every response is
  the only reliable signal (Phase 5).
- Gmail `history.list` returns **404**, not 410, for a stale `historyId` (deferred — Google
  Workspace connectors (Gmail/Calendar/Business) stayed behind a flag past Phase 8; only X,
  LinkedIn, TikTok, YouTube and Keitaro shipped, per spec §8.5's own "optional in v1" carve-out).
- X pricing is credit-based pay-per-use as of 2026 with 24h dedup; the manifest encodes a spend
  model, not tiers, with a per-connection `spendCap` required before any call is billable (Phase
  8, ADR-019 — re-verify the rate card against X's live developer docs before going live).
- TikTok's Business Messaging window is documented at 48 hours by third-party integrators
  (SleekFlow, Respond.io); TikTok's own developer docs were not directly reachable while building
  the connector, so this figure is flagged for re-verification in `docs/connectors/tiktok.md`
  rather than treated as confirmed (Phase 8).
