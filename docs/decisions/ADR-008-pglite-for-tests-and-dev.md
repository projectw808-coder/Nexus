# ADR-008 — PGlite is the test database and an optional Docker-free dev backend

**Status:** accepted (Phase 1) · **Spec:** §3 (Testcontainers), §15

## Context

The spec names Testcontainers for integration tests. The build machine has no Docker, and the
tests that matter most in Phase 1 (RLS, scoped client, isolation) need a real Postgres with
pgvector, pg_trgm and citext — not a mock.

## Decision

- `@nexus/db/testing` opens PGlite (Postgres compiled to WASM) in-process with the three
  extensions, applies every migration in `prisma/migrations` in order, creates `nexus_app` and
  `SET ROLE`s to it, then hands out a Prisma client through `pglite-prisma-adapter`. RLS,
  `set_config`, citext and HNSW indexes all behave as in production.
- `DATABASE_URL=pglite://<dir>` makes the application itself use a persisted PGlite (migrations
  auto-applied, same role setup). Single process only; the worker cannot share the directory.
- CI still provisions real Postgres for `migrate deploy`, the drift gate and the build, so the
  `pg` adapter path is exercised on every push. Testcontainers remains available for suites that
  need multiple connections (Phase 4 load tests).

## Consequences

Test files that open PGlite run one at a time (`fileParallelism: false`) — two WASM instances in
parallel forks crashed on Windows. The PGlite packages are runtime dependencies of `@nexus/db`
so the dev backend works from a production install; they are never loaded unless the URL asks.
