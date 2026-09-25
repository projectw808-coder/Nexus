# ADR-013 — The sync engine is a package with a sink seam for stages 4–7

**Status:** accepted (Phase 4) · **Spec:** §4.1 pipeline, §9 sync engine, §16 Phase 4

## Context

§9 places the sync engine in `apps/worker`. Phase 4 needs the same engine in three hosts: the
worker (BullMQ, continuously), the web tier (inline when Redis is absent, and for the webhook
ack path and OAuth connect flow), and the operator CLI (`pnpm nexus replay`, `dlq replay`).
Stages 4–7 of the pipeline (identity, materialise, react, notify) belong to Phases 6, 10 and 9;
Phase 4 must ship a complete, measurable acquire → persist → normalise path without stubbing
those stages.

## Decision

- The engine lives in `packages/sync` (`@nexus/sync`) and takes its collaborators as `SyncDeps`:
  tenant runtime, vault, rate limiter, connector registry, job bus, logger, sink and app
  secrets. `apps/worker` hosts it (`src/sync.ts`) with BullMQ workers per pipeline queue; the
  web tier and the CLI use the inline bus. `apps/worker` remains the only process that runs it
  continuously, so §9's intent holds.
- Stages 4–7 hang off one seam: `CanonicalSink.materialize(batch)`, called after
  normalisation with the canonical entities and their raw-row ids. Phase 4 ships
  `countingSink`; Phase 6 replaces it with identity resolution + timeline materialisation and
  later phases add automation and notification behind the same call. The sink must be
  idempotent per `(objectId, entity)` because replay calls it again.
- Persistence commits the page, the cursor and the run counters in one transaction, so a
  killed worker resumes from the last committed page. Because an in-memory queue loses its
  pending normalise jobs on a kill, every successful sync (and worker startup) re-queues raw
  rows that still lack `normalizedAt` — the "every persisted object is normalised" guarantee
  does not depend on queue durability.
- Retries are progress-aware: a sync job that committed at least one page and then hits a
  retryable failure continues as a new job after the backoff instead of consuming its attempt
  budget; only a job that makes no progress burns attempts and dead-letters after six.
- The connector registry (`packages/sync/src/registry.ts`) is the single place that imports
  platform packages (§0.4). Core code addresses connectors by `Platform` only.

## Consequences

- One engine, three hosts, one test suite (`packages/sync/src/engine.test.ts`) proving the
  Phase 4 acceptance on PGlite with the inline bus.
- BullMQ-specific behaviour (priorities per lane, custom backoff, job schedulers) is confined
  to `apps/worker/src/bus.ts` and `apps/web/server/sync.ts`.
- The counting sink means Phase 4 produces no `Person`/`Message` rows yet; the raw store and
  normalised entities are what later phases consume. `docs/PROGRESS.md` lists this under
  Phase 4's deferred items.
