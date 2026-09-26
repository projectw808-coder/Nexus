# ADR-020 — `packages/mail`, field-mapping's scope, and the sparkline's data source

**Status:** accepted (Phase 9) · **Spec:** §12.2.C, §16 Phase 9 · **Builds on:** ADR-004, ADR-013

## Context

Phase 9 is the integrations hub and health console: a connection grid, a 7-tab connection-detail
view, field mapping, permission grants, webhook delivery + replay, and a workspace health
console. Three things needed a decision that the spec leaves implicit.

## Decisions

1. **`packages/mail` is a new shared package, not `apps/web/lib/mail` reused by the worker.**
   The token-sweep job (`packages/sync/src/token-refresh.ts`, run by `apps/worker`) must email
   the workspace owner when it pauses a connection to `RECONNECT_REQUIRED` — the same
   reconnect-required event the web app already had a magic-link mailer for, but living in
   `apps/web/lib/`, which the worker cannot import. This is the same shape ADR-004 already
   solved for logging: a capability both apps need, that is neither domain code (`core`) nor
   configuration (`config`). `apps/web/lib/mail/` is extracted verbatim into `@nexus/mail`
   (`MailProvider`, `SmtpMailProvider`, `MemoryMailProvider`, template functions); web keeps
   calling it for magic links, `packages/sync`'s `mailNotifier` is the second caller. The
   default `Notifier` remains `loggingNotifier`; `mailNotifier` is wired in by the worker's
   bootstrap, not by `packages/sync` itself, so the sync package stays free of a hard mail
   dependency.

2. **Field mapping's preview applies draft rules directly to `ExternalObject.raw`; it is not
   wired into the live normalize pipeline.** The schema comment on `FieldMappingRule` describes
   full resolution semantics — explicit rule, then connector manifest default, then
   `Record.values._unmapped` — but making `normalize()` consult per-connection mapping rules is
   a sync-engine change that touches every connector, not an integrations-hub screen. Phase 9
   ships full CRUD and a live preview (`previewFieldMapping`, walking each sample's raw payload
   with a `getByPath` helper) so a user can compose and see the effect of rules before Phase 10+
   makes them binding. This is a scoped deferral, not a stub: nothing in Phase 9's acceptance
   criteria (§16) requires mapping rules to affect what actually gets synced.

3. **The connection card's 7-day sparkline reads `SyncRun`, bucketed in application code — no
   new rollup table.** `BudgetSnapshot`/`RateBudget` are live point-in-time reads with no
   history; adding a time-series table for one sparkline is more than the UI needs.
   `SyncRun` already has one row per resource poll with `startedAt`/`itemsFetched`, which is
   sufficient for a 7-bucket-per-day count (`dailyRunActivity`, `packages/db/src/sync/runs.ts`).
   If a later phase needs finer-grained or longer-retention history, that is a rollup-table
   decision to make then, against real query patterns, not now against one card.

## Consequences

`@nexus/mail` becomes the 22nd workspace package. `packages/sync` gains an optional mail
dependency only at the worker's wiring point, not in the package itself. The health console's
drift section shows "not measured yet" rather than a fabricated zero, since
`ConnectionDriftSample` has no writers yet — nightly reconciliation (spec §9.1) remains
unimplemented and is not a Phase 9 requirement.
