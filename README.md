# Nexus

A multi-channel, API-native CRM with per-platform control. The full specification lives with the
product owner; this repo tracks its build plan in [docs/PROGRESS.md](docs/PROGRESS.md), the
architecture restatement in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and decisions in
[docs/decisions](docs/decisions).

## Quick start

Requirements: Node 24, pnpm 12 (`corepack enable`), Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up          # Postgres+pgvector, Redis, MinIO, Mailpit, Jaeger — waits for health
pnpm db:generate
pnpm db:migrate        # prisma migrate dev
pnpm dev               # web :3000, worker health :3001
```

Then open http://localhost:3000 — the status page shows Postgres/Redis health and a button that
sends a job to the worker and links the resulting trace in Jaeger (http://localhost:16686).

| Service | URL                                                           |
| ------- | ------------------------------------------------------------- |
| Web     | http://localhost:3000                                         |
| Health  | http://localhost:3000/healthz · http://localhost:3001/healthz |
| Jaeger  | http://localhost:16686                                        |
| MinIO   | http://localhost:9001 (nexus / nexus-secret)                  |
| Mailpit | http://localhost:8025                                         |

## Layout

```
apps/web         Next.js — UI, tRPC, REST v1, webhook receivers
apps/worker      BullMQ processors (sync, normalize, resolve, automate, ai, outbound, system)
packages/db      Prisma schema, migrations, tenant-scoped client
packages/core    domain: Result, failure taxonomy, identity, timeline
packages/connectors/sdk   the connector SPI, canonical entities, quota shapes
packages/config  zod env, feature flags, queue names
packages/telemetry  pino + OpenTelemetry + queue trace propagation
packages/ui      design tokens (light/dark), theme
packages/{automation,ai,testing}  scaffolds for later phases
tooling/eslint-plugin-nexus  structural rules (no direct platform fetch, no unscoped Prisma)
infra/           docker-compose, Terraform skeleton
docs/            ARCHITECTURE, PROGRESS, ADRs, connector capability sheets
```

## Checks

```bash
pnpm check     # typecheck + lint + test across the workspace
pnpm --filter @nexus/web e2e   # Playwright: builds nothing, needs `pnpm --filter @nexus/web build` first
pnpm db:drift  # migration drift gate (needs SHADOW_DATABASE_URL)
pnpm nexus     # operator CLI: replay, dlq list|replay, sync, sweep-tokens, rescore, new-connector <name>
# Connecting Meta (Facebook Pages + Instagram): see docs/connectors/meta.md for the app setup checklist.
```

CI runs the same gates in `.github/workflows/ci.yml`.
