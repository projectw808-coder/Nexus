# Progress

Running log of what is done, stubbed and deferred (spec §0.10). Updated at every phase boundary.
Acceptance criteria are copied from §16 verbatim so nobody can quietly soften them.

**Legend:** `[x]` done and verified · `[~]` built, not verified here (reason given) · `[ ]` not started

---

## Phase 0 — Foundation ✅ built, partially verified

Monorepo, Docker Compose (Postgres+pgvector, Redis, MinIO, Mailpit), Prisma bootstrap,
zod-validated env, CI skeleton, logging/tracing, error taxonomy, the design tokens package with
light/dark.

**Accept:**

- [~] `pnpm dev` brings up web+worker+infra — compose + turbo wired; **not run on this machine (no
  Docker installed)**. Typecheck, lint, unit tests and `next build` pass.
- [~] `/healthz` green — implemented for web (`apps/web/app/healthz`) and worker (`:3001/healthz`);
  reports 503 with per-check detail when a dependency is down. Verified by running both
  processes without infra: each answers `degraded` with the Postgres/Redis error and a trace id,
  and the worker stays up while Redis reconnects. Green state needs Docker.
- [~] a trace from an HTTP request through a queued job is visible end to end — implemented:
  `POST /api/system/ping` injects the trace carrier into the job, the worker joins it; proven by a
  unit test with an in-memory exporter (`packages/telemetry/src/propagation.test.ts`). Jaeger UI
  check needs Docker.
- [x] dark mode toggles and persists — three-state toggle, localStorage + cookie, SSR emits
      `data-theme` so there is no flash; explicit toggle beats the OS both ways (tokens.css).
      Verified in a browser whose OS prefers dark: choosing Light switched the page plane to
      `#f9f9f7`, and after a reload the server HTML already carried `data-theme="light"`.

**Verification notes.** `pnpm check` (typecheck, 63 unit tests, lint with the three custom
rules, Prettier) and `next build` pass. Docker is not installed on the build machine, so
`pnpm infra:up`, `prisma migrate dev` and the drift gate were not run; the init migration was
produced with `prisma migrate diff --from-empty` (no database needed) and validates. `next dev`
writes `apps/web/AGENTS.md` and `CLAUDE.md` pointing agents at the bundled Next 16 docs; they
are committed on purpose.

**Done:** root workspace (pnpm 12 + Turborepo 2) · `packages/config` (Appendix A env, flags,
queue names) · `packages/core` (`Result`, `NexusError`, §9.2 taxonomy) · `packages/telemetry`
(pino with redaction, OTel SDK, queue propagation) · `packages/ui` (tokens.css, tokens.ts, theme)
· `packages/db` (full Phase 0–2 schema, init migration, tenant-model generator, health check) ·
`packages/connectors/sdk` (complete SPI, manifest, quota shapes, canonical entities) · `apps/web`
(Next 16, instrumentation, healthz, ping, status page, theme toggle) · `apps/worker` (BullMQ
worker, health server, graceful shutdown) · ESLint with `nexus/no-direct-platform-fetch`,
`nexus/no-base-prisma`, `nexus/no-raw-query` · GitHub Actions CI · Dockerfiles · Terraform skeleton
· ADR-001…005 · this file.

**Stubbed:** `packages/automation`, `packages/ai`, `packages/testing` (layout only) · `prisma/seed.ts`
(prints and exits) · Terraform (provider block only) · CI placeholders for e2e/axe/Lighthouse/k6.

**Deferred to Phase 1:** `withTenant()` + scoped client + RLS policies (schema and the
`nexus_current_workspace()` helper exist), Auth.js, CASL, AuditLog writes.

---

## Phase 1 — Tenancy, auth, authz ✅ built

Workspace/User/Membership, Auth.js (magic link + Google + Microsoft), invitations, roles, the scoped
Prisma client, RLS policies, CASL abilities, `AuditLog`, the ESLint rules.

- [x] the cross-tenant isolation test suite passes for every route — generated from the router
      manifest (`apps/web/server/isolation.test.ts`): a non-member gets NOT_FOUND on every tenant
      procedure, a member of B using A's ids gets NOT_FOUND with A untouched, anonymous gets
      UNAUTHORIZED, and a procedure without a fixture fails the suite.
- [x] a `viewer` cannot mutate anything — every tenant mutation returns FORBIDDEN for a VIEWER.
- [x] every mutation writes an audit row — enforced by `tenantProcedure` (a mutation that ends
      with no audit row is rejected and rolled back, ADR-007) and asserted per mutation.
- [x] RLS blocks a deliberately unscoped query at the DB level — `packages/db/src/scoped.test.ts`
      runs as the `nexus_app` role on PGlite: an unscoped `SELECT` returns no rows while the
      superuser sees them, and an insert for another workspace fails with `42501`.

**Done:** `withTenant` / `withSystem` (`packages/db/src/scoped.ts`: transaction + `SET LOCAL`,
scoped client extension covering unique and filter wheres, creates, nested include/select,
relation filters and nested writes, generated `TENANT_MODELS` + `MODEL_META`) · RLS migration
generated from the tenant models with a coverage test (ADR-006) · `Invitation` model · tenancy
helpers (workspaces per user, actor + grants, create workspace, accept invitation) · CASL
abilities from role + per-connection grants · tRPC routers `workspace`, `member`, `invitation`,
`audit`, `me` with the taxonomy error mapping · `MailProvider` (SMTP/Mailpit, memory) · Auth.js
v5 (magic link via MailProvider, Google, Microsoft Entra ID, Prisma adapter with `avatarUrl`
mapping) · screens: sign-in, workspace list/new, workspace shell with rail, settings → general /
members / audit log, invitation landing, all with empty/loading/error/permission-denied states ·
PGlite test harness and `pglite://` dev backend (ADR-008) · CI creates the app role.

**Verification notes.** Unit/integration: 27 db tests + 19 web tests on PGlite, `pnpm check`
green, `next build` green. End to end on the running app (`DATABASE_URL=pglite://`, no Docker):
magic-link sign-in → empty workspace list → create workspace → shell with rail and switcher →
members page (self controls disabled with reasons) → invitation created and mailed → signed-out
invitation preview → invitee signs in and lands back on the invite → accepts → owner changes the
role → audit log lists `workspace.created`, `member.joined`, `invitation.created`,
`invitation.accepted`, `member.role_changed` with actors, and the audit page renders them. The
walkthrough drove Auth.js and the tRPC endpoint over HTTP and rendered every page server-side;
the in-app browser pane would not paint on this machine, so the client-side islands (rail
collapse, confirm step, slug suggestion) are verified by typecheck and build only.

**Deferred:** React Email templates (plain HTML for now) · SAML interface · MFA · API keys
(Phase 11) · field-level permissions (Phase 2, needs attributes) · `Team`/`TeamMember` UI ·
`x-pathname` header so sign-in returns to the original page (a `proxy.ts` in Phase 3).

## Phase 2 — The object graph ✅ built

ObjectType/Attribute/Record/RecordRelation, JSONB + generated-column indexing with the migration
generator, validation from attribute types, List/ListEntry with fractional indexing and per-list
attributes, saved views, search (FTS + trigram), CSV import with column mapping and a dry-run
preview, export.

- [x] create a custom object with 12 attribute types and 100k seeded records —
      `packages/db/src/objects/objects.test.ts` creates a "widget" object with TEXT, NUMBER,
      CURRENCY, DATE, DATETIME, SELECT, MULTISELECT, BOOLEAN, EMAIL, PHONE, URL, RATING and seeds
      100,000 rows in SQL.
- [x] filter+sort on an indexed attribute < 200 ms p95 — the same test builds the generated
      column + btree through `runIndexBuild` (ADR-009) and asserts p95 < 200 ms over 20 runs on
      PGlite; the trigger keeps the column current for new writes.
- [x] a record sits in three pipelines with different stage values in each — asserted at the db
      layer and through the API (`apps/web/server/objects.test.ts`), with stage history.
- [x] import 10k rows with a preview and a rollback — dry-run preview reports 9,999 valid / 1
      invalid with the row and column; the run creates 9,999 records tagged with the job; rollback
      soft-deletes exactly those and marks the job ROLLED_BACK.

**Done:** attribute type system with per-type config and value validation, CSV coercion and the
filter DSL (`packages/core/src/attributes.ts`) · system Person/Company/Deal objects seeded per
workspace with protected attributes (ADR-001) and a default Sales pipeline · record query builder
(keyset cursor, filters typed per attribute, FTS + trigram search) and validated writes with
uniqueness, relation sync and field-level permissions applied in the serializer, on writes and in
export · generated-column index builder as a job with progress, plus 24h reversible attribute
deletion and purge · lists with fractional ordering and rebalance, stage history · saved views ·
CSV import (preview → run in chunks → rollback) · export CSV/JSON · tRPC routers `objectType`,
`attribute`, `record` + `person`/`company`/`deal` conveniences, `list`, `listEntry`, `view`,
`search`, `import`, `export` — all covered by the generated isolation/viewer/audit suite (75
procedures) · worker processors `index.build`, `index.drop`, hourly `attribute.purge`, and resume
of pending builds at startup · job dispatch with inline fallback when Redis is absent (ADR-010) ·
screens: records index and table with filters/sort/search/saved views/export, record create/edit/
detail, lists index and pipeline board, objects & attributes admin with migration preview and
restore, import wizard, global search.

**Verification notes.** Unit/integration: 9 db object-graph tests (incl. the 100k benchmark, the
10k import and the pre-Phase-2 workspace backfill), 6 router tests, the generated
isolation/viewer/audit suite over 75 procedures, `pnpm check` green, `next build` green. On the
running app (PGlite backend, no Docker or Redis): a workspace created in Phase 1 received its
system objects on first open; the objects admin rendered the migration preview line; creating a
NUMBER attribute with "indexed" dispatched the build inline and it reached READY 100%; a CSV
import previewed 3 rows with the bad e-mail flagged at row 4 / column Email, ran to 2 created +
1 failed, and its page showed "completed" with the rollback control; the records table filtered
`score ≥ 90`, sorted by the indexed attribute and searched by name; global search found the
imported person; the Sales pipeline board rendered its stages. Two environment notes: heavy
PGlite suites must not run in parallel (test task concurrency is 1), and the UI agent building
the Phase 2 screens was cut off by a session limit — the objects admin, import wizard and search
page were finished by hand afterwards.

**Deferred:** FORMULA/ROLLUP evaluation and AI_RESEARCH values (Phase 10; the types validate
and are read-only) · the 1M-row benchmark against real Postgres (`k6`/Phase 11; 100k on PGlite
here) · TanStack table/board interactions (Phase 3) · OpenSearch behind the search interface.

## Phase 3 — Records UI

Table view (TanStack Table + Virtual: resize, reorder, pin, group, inline edit, aggregates), board
view, record detail shell, ⌘K palette, global search, bulk actions, the four mandatory states on
every screen.

- [ ] 100k-row table scrolls at 60fps
- [ ] every action keyboard-reachable
- [ ] axe clean

## Phase 4 — Connector SDK

The SPI, OAuth helpers (code + PKCE + refresh), `TokenVault` with envelope encryption, the
four-shape rate limiter with reserve/settle and priority lanes, circuit breaker, cursor store,
`ExternalObject` raw store, the seven-stage pipeline, `SyncRun`, webhook receiver + verification
framework, DLQ + replay CLI, the contract test suite, `new-connector` generator, and a mock
platform (configurable latency, 429s, 5xx, schema drift and dropped webhooks) used by all tests.

- [ ] a mock connector backfills 50k objects
- [ ] resumes after a worker kill
- [ ] survives 30% injected 429/5xx without data loss
- [ ] replaying every webhook 3× produces zero duplicates

## Phase 5 — Meta (Facebook + Instagram)

Full connector: auth + Page/IG account discovery, DMs, comments, mentions, reviews, lead forms,
insights, all six webhook topics, usage-header-driven budgeting, the 24-hour messaging window in
`preflight`, the version-drift monitor.

- [ ] connect a real test Page and IG account
- [ ] a DM sent from a phone lands as a `Conversation` + `Message` row and renders on a bare
      conversation list in < 10 s
- [ ] a reply sent from that scaffold lands on the platform
- [ ] the window countdown blocks a send at 24h+1m with a clear reason
- [ ] pausing the Facebook connection leaves Instagram syncing

## Phase 6 — Identity resolution & the unified timeline

Tiered matching, evidence capture, the "why" panel, suggestion queue, `RecordMerge` with reversible
merge/unmerge, `NeverMerge`, nightly re-scoring, `TimelineEvent` assembly with provenance and
per-platform filters, and the identity-then-record backfill described in §6.6(3).

- [ ] seed a person with five channel identities and confirm one Person with five chips
- [ ] a correct chronological timeline
- [ ] an explainable merge
- [ ] a state identical to the pre-merge snapshot after merge→unmerge
- [ ] an unresolved identity's events are visible on the identity and move to the Person on
      resolution without duplication

## Phase 7 — Unified Inbox

Three-pane inbox, per-platform tabs, assignment, statuses, snooze, SLA timers, internal notes,
canned replies, platform-aware composer, the context sidebar (backed by Phase 6), SSE realtime,
keyboard model, bulk triage.

- [ ] the e2e path in §15 passes
- [ ] two users see each other's assignment changes live
- [ ] inbox p95 load < 500 ms with 50k conversations

## Phase 8 — Remaining platforms

X, LinkedIn, TikTok, YouTube and Keitaro — each with its approval/setup checklist, its quota or
spend model, its constraints encoded in `preflight`, its capability sheet in `docs/connectors/`,
and its fixtures.

- [ ] each connector passes the shared contract suite
- [ ] the YouTube connector refuses `search.list` from a sync path and reports both remaining
      units and remaining capped-endpoint calls
- [ ] the X connector projects spend correctly with the 24h dedup ledger applied and hard-stops at
      its configured cap
- [ ] the Keitaro connector ingests a `lead → sale → rejected` transition on one `subid`+`tid` and
      correctly adds then reverses the deal revenue
- [ ] per-connection permission grants demonstrably restrict a `member` to read-only on LinkedIn
      while allowing engage on Instagram

## Phase 9 — Integrations hub & health console

Connection grid, detail tabs, field mapping UI with live preview, webhook delivery log + replay,
the workspace health console, the quota simulator, reconnect flows, disconnect-and-purge.

- [ ] a token expiring in 3 days shows a countdown, emails the owner, and pauses only its own
      connection
- [ ] a deliberately broken webhook signature shows up as rejected with a remediation string
- [ ] the simulator's estimate for a seeded volume is within 20% of observed consumption over a
      24h run

## Phase 10 — Automation + AI

The workflow engine with dry-run, loop detection and run history; summaries, relationship briefs,
AI research attributes, reply drafting, transparent lead scoring, hybrid semantic search; budgets
and kill switches.

- [ ] a workflow that routes Instagram comments containing "price" to a pipeline and assigns by
      round-robin passes a 7-day dry run and then runs live
- [ ] an AI summary cites real timeline events
- [ ] the kill switch stops all model calls within one request

## Phase 11 — Reports, public API, compliance, polish

Dashboard builder and the widget catalogue under §12.4; REST v1 + OpenAPI + API keys + outbound
webhooks; DSAR export/erasure; retention purge; consent gates; onboarding checklist; empty-state
seeding; docs.

- [ ] every §2 performance budget met
- [ ] every chart passes the §12.4 rules
- [ ] a DSAR erasure removes every trace of a person across all channels and leaves a tombstone
- [ ] the OpenAPI spec generates a working client
