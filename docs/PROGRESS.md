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

## Phase 3 — Records UI ✅ built

Table view (TanStack Table + Virtual: resize, reorder, pin, group, inline edit, aggregates), board
view, record detail shell, ⌘K palette, global search, bulk actions, the four mandatory states on
every screen.

- [x] 100k-row table scrolls at 60fps — `apps/web/e2e/records-table.spec.ts` signs in as the
      owner of the seeded `e2e` workspace (100,000 `widget` rows inserted in SQL by
      `packages/db/src/testing/seed-e2e.ts`), scrolls the grid for three seconds while sampling
      `requestAnimationFrame` deltas, and asserts fewer than 10% long frames and a p95 frame under
      40 ms. Measured on the build machine (headless Chromium, production build on PGlite):
      180 frames, 0 long frames, p95 16.8 ms. Only the viewport plus overscan is in the DOM
      (< 80 rows) and the next cursor page is requested as the viewport nears the loaded end.
- [x] every action keyboard-reachable — `apps/web/e2e/keyboard.spec.ts` and the second test in
      `records-table.spec.ts` run with no pointer: ⌘K → type → Enter opens the widgets table;
      arrow keys move a roving `gridcell` focus; Enter opens the record on the label column, opens
      the column menu on the header row and edits any other cell (F2 and Space also edit,
      Shift+Space selects, Ctrl+A selects loaded rows, Escape clears); the column menu
      (sort / move / pin / group / reset / hide) is a `menu` with arrow navigation; grouping and
      ungrouping by Tier, selecting two rows and dismissing the bulk bar all happen from the
      keyboard; on the record page a value is edited inline and a note (Ctrl+Enter) and a task
      (Enter) are created; on the board a card is moved between stages via its Move menu.
- [x] axe clean — `apps/web/e2e/a11y.spec.ts` runs `@axe-core/playwright` with the WCAG 2.0/2.1/2.2
      A + AA tags on 19 static routes (sign-in, check-email, error, home, new workspace, workspace
      home, records index, widgets table with and without a search, new record, import wizard,
      lists, search, settings general/members/objects/object detail/audit, status) plus a record
      page and the pipeline board, failing on any serious or critical violation. All pass after
      three fixes the gate found: muted ink and link colours raised to ≥ 4.5:1 on every surface
      in both themes (`packages/ui/src/tokens.css`), links inside text now carry an underline
      (`link-in-text-block`), and the record attribute list is a valid `dl`.

What was built:

- `apps/web/lib/trpc-client.tsx` — typed tRPC client over TanStack Query for client components
  (ADR-011). `apps/web/components/data-grid/*` — the grid (cursor-paged `useInfiniteQuery`,
  virtualized rows, column order / width / pinning / visibility / grouping persisted per object
  in `localStorage`, footer aggregates over loaded rows, roving keyboard model, inline cell
  editors per attribute type with optimistic update and rollback) and the bulk bar (delete, add
  to list, set a field on the selection, export selection as CSV).
- `apps/web/components/board/board-view.tsx` — dnd-kit board with optimistic moves persisted
  through `listEntry.move`, WIP limits and rot highlighting from the list settings, and a
  per-card Move menu so every drag has a keyboard equivalent.
- `apps/web/components/command-palette.tsx` — ⌘K dialog (combobox + listbox) with navigation,
  create and settings commands plus debounced cross-object search results.
- `apps/web/components/record/*` — inline-editable attribute panel with per-field history from
  the audit trail, notes panel, tasks panel; new `note` and `task` routers and `record.bulkUpdate`
  / `record.history` / `listEntry.addMany` procedures, all covered by the generated isolation
  suite.
- Playwright + axe in CI (`.github/workflows/ci.yml`) against the production build with the
  flag-gated e2e sign-in endpoint (ADR-012); traces uploaded on failure.

**Deferred:** the record Timeline tab shows a placeholder until connectors exist (Phase 4/5) ·
cross-device sync of grid layout (ADR-011 names the path) · group aggregates over the whole
table rather than loaded rows (needs a server-side group query; the UI labels the scope).

## Phase 4 — Connector SDK ✅ built

The SPI, OAuth helpers (code + PKCE + refresh), `TokenVault` with envelope encryption, the
four-shape rate limiter with reserve/settle and priority lanes, circuit breaker, cursor store,
`ExternalObject` raw store, the seven-stage pipeline, `SyncRun`, webhook receiver + verification
framework, DLQ + replay CLI, the contract test suite, `new-connector` generator, and a mock
platform (configurable latency, 429s, 5xx, schema drift and dropped webhooks) used by all tests.

- [x] a mock connector backfills 50k objects — `packages/sync/src/engine.test.ts` connects the
      mock platform through the real OAuth flow (PKCE, signed state, vaulted token) and backfills
      one account: 50,000 objects persisted raw, all 50,000 normalized through the sink, zero
      quarantined, zero dead letters. On the build machine (PGlite, inline bus, kill included):
      50,000 objects in 21.5 s, about 139,000 objects/minute, 104 platform calls of 500 items.
- [x] resumes after a worker kill — the same test aborts the first worker from inside the
      request path after a dozen pages (14,500 objects committed), starts a second worker with
      a fresh bus and limiter, and finishes from the saved cursors: every run is CANCELLED or
      SUCCEEDED, the second worker makes fewer than one page's worth of extra calls, and rows
      whose normalize job died with the first worker's queue are re-queued by the
      pending-normalization sweep.
- [x] survives 30% injected 429/5xx without data loss — 6,000 objects with 15% 429 (with
      `Retry-After`) and 15% 503 injected per request: all 6,000 persisted and normalized, no dead
      letters, failed runs recorded with their taxonomy code and remediation, the connection
      dips to DEGRADED and recovers to CONNECTED.
- [x] replaying every webhook 3× produces zero duplicates — 200 new comments announced by
      signed webhooks, each delivered three times (600 `WebhookEvent` rows, all verified and
      processed): exactly 200 new `ExternalObject` rows and no duplicate entities; a poll that
      returns the same comments afterwards changes nothing. Tampered, unsigned and
      unknown-platform payloads get 401/404 and are logged unverified.

What was built:

- `@nexus/connector-sdk` runtime: envelope encryption + `KeyProvider` (ADR-014), OAuth helpers
  (PKCE, HMAC-signed state, code exchange, refresh, revoke, 70% refresh math), the four-shape
  `RateLimiter` over a `BudgetStore` (memory + Redis CAS) with lane fractions, observed
  headers, the 24h dedup ledger and the circuit breaker, the injected `HttpClient` (retries
  with full jitter, `Retry-After`, breaker, status classification, served-version check),
  webhook verification primitives (HMAC-SHA256, shared secret, RS256 JWT), the quota
  simulator, test doubles (`@nexus/connector-sdk/testing`) and the contract suite
  (`@nexus/connector-sdk/contract`). 79 unit tests.
- `@nexus/connector-mock`: the mock platform (in-process `fetch` or HTTP, seeded data, real
  rate-limit headers, fault injection) and the reference connector; 23 tests including the
  contract suite and golden normalize snapshots. `docs/connectors/mock.md`.
- `@nexus/db`: `WorkspaceKey`, `VaultEntry`, `DeadLetter` models with RLS; the vault; raw
  store with content-hash idempotency; cursor, run, webhook-event, dead-letter and
  integration-error stores; connection lifecycle helpers.
- `@nexus/sync` (ADR-013): inline job bus with the §9.2 retry policy, connector registry,
  stages 1–3 with the sink seam for 4–7, webhook intake and processing, failure → behaviour
  mapping, replay (per connection and per dead letter), poll planner, token sweep, OAuth
  connect flow with audit, `createSyncDeps` from the environment.
- Hosts: worker BullMQ bus and pipeline workers with schedulers (poll plan every 5 min, token
  sweep hourly, recovery at boot); web `/api/webhooks/:platform[/:connectionId]`,
  `/api/connect/:platform/start|callback`, the `connection` tRPC router (13 procedures, all in
  the generated isolation suite) and inline engine fallback without Redis.
- `pnpm nexus replay | dlq list | dlq replay | sync | sweep-tokens | new-connector`. The
  generator scaffolds a package that typechecks, lints and passes the contract suite before any
  platform detail is filled in (verified by generating `demo-social` and running it).

**Deferred:** stages 4–7 (identity resolution, materialization, automation, notification) sit
behind the sink seam and arrive with Phases 6, 9 and 10 · the cloud KMS `KeyProvider` (Phase 11
deploy; `local:*` is refused outside dev/test) · e-mailing the connection owner on
RECONNECT_REQUIRED (the `Notifier` logs today; the health console wires mail in Phase 9) ·
the outbound `OutboundAction` queue (`execute`/`preflight` are implemented on the SPI and the
mock; the send flow lands with the inbox in Phase 7) · the integrations hub UI (Phase 9).

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
