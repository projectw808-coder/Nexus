# ADR-010 — Web-tier jobs go to BullMQ when Redis is reachable, else run inline

**Status:** accepted (Phase 2) · **Spec:** §4 queues, §16 Phase 0/2

## Context

Index builds, index drops and attribute purges are queue jobs. A developer machine without
Redis (the build machine, ADR-008) must still be able to flip `isIndexed` and see it finish.

## Decision

`apps/web/server/jobs.ts` probes Redis once (1.5 s). If a connection succeeds, jobs are added to
the `system` queue and the worker processes them. If not, the same job function runs inline in
the web process on the next tick, after the request's transaction has committed. The tRPC
context exposes this as `ctx.jobs.dispatch`; tests inject a recording double.

Long-running mutations that need their own transactions (CSV import) use `tenantJobProcedure`:
same actor resolution, ability and audit enforcement as `tenantProcedure`, but no ambient
transaction, so PGlite's single session never nests.

## Consequences

Production always has Redis, so inline mode is a development convenience only; the worker also
resumes any attribute left BUILDING at startup and schedules the hourly purge.
