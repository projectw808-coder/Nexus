# Deploying Nexus to Railway (single-company use)

This is a runbook for the first real deployment, not a description of anything already built.
Nothing here has been executed or verified against a live Railway project — I have no Railway or
GoDaddy access. Treat the Dockerfiles as a strong starting point that will very likely need one or
two rounds of iteration against Railway's actual build logs, since there is no local Docker in this
environment to test-build them against first.

## Services to create in Railway

One Railway project, five services:

| Service        | What it is                                       | Source                                                  |
| -------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `postgres`     | Database                                         | Railway's Postgres template, **but see pgvector below** |
| `redis`        | Job queue (BullMQ), rate limiting                | Railway's Redis template                                |
| `web`          | The Next.js app                                  | `apps/web/Dockerfile`                                   |
| `worker`       | Background jobs (sync, automation, AI, webhooks) | `apps/worker/Dockerfile`                                |
| object storage | DSAR export files                                | not a Railway template — see below                      |

### Postgres must have `pgvector`

`packages/db/prisma/schema.prisma` requires the `vector`, `pg_trgm` and `citext` Postgres
extensions (semantic search, fuzzy identity matching, case-insensitive email). Railway's default
Postgres template is plain `postgres:16` **without** `pgvector` — the same reason CI's own Postgres
service uses `pgvector/pgvector:pg16` rather than the vanilla image (`.github/workflows/ci.yml`).

Two ways to get this on Railway:

1. Deploy Postgres from a custom Docker image instead of the template: create the service as
   "Empty Service" → Docker image → `pgvector/pgvector:pg16` (the same image CI already uses,
   already proven to work with this schema).
2. Or use Railway's own "pgvector" template from their template marketplace, if one is listed —
   check before falling back to (1).

Whichever you pick, after the database is up, `pnpm db:deploy` (below) creates the extensions —
the first migration (`20260924000000_init`) already contains `CREATE EXTENSION IF NOT EXISTS
vector/pg_trgm/citext`. Nothing manual needed beyond having the extension available to install.

### Object storage: pick a provider

Railway has no built-in S3-compatible storage. `packages/config/src/env.ts` requires
`S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` regardless (used today only by the
compliance layer's DSAR export — `packages/db/src/compliance/storage.ts`). Cheapest, simplest
option for a single-company deployment: **Cloudflare R2** (S3-compatible API, a generous free
tier, no egress fees). Create one bucket, an API token scoped to it, and use its S3-compatible
endpoint. AWS S3 works identically if you'd rather stay in one cloud less.

## Environment variables

Every variable below with no default is **required** — `packages/config/src/env.ts`'s `loadEnv()`
throws at boot listing everything missing, all at once, so a misconfigured deploy fails fast and
loud rather than partially working.

Set these identically on **both** `web` and `worker` (the worker needs the same database/queue/
storage config the web app does):

```
NODE_ENV=production
DATABASE_URL=<Postgres connection string, app role — see "two DB roles" below>
DATABASE_ADMIN_URL=<Postgres connection string, table-owner role, for migrations>
REDIS_URL=<Railway Redis's connection string>
S3_ENDPOINT=<R2 or S3 endpoint>
S3_BUCKET=<bucket name>
S3_ACCESS_KEY=<access key>
S3_SECRET_KEY=<secret key>
APP_URL=https://<your GoDaddy domain>
AUTH_SECRET=<32+ random bytes — generate with `openssl rand -base64 32`, NOT the CI test value>
KMS_MASTER_KEY_ID=local:prod
ENCRYPTION_KEY_FALLBACK=<32 bytes, base64 — generate with `openssl rand -base64 32`>
SMTP_URL=<real SMTP provider URL, e.g. smtp://user:pass@smtp.postmarkapp.com:587>
FEATURE_MOCK_PLATFORM=false
```

Read each of these before setting it:

- **`KMS_MASTER_KEY_ID=local:prod`** — the codebase's only implemented KMS backend today is
  `local:*`, which derives the encryption key from `ENCRYPTION_KEY_FALLBACK` rather than calling a
  real KMS. That's fine for a single-company deployment as long as `ENCRYPTION_KEY_FALLBACK` is a
  real secret generated once and **never rotated casually** — it encrypts every stored platform
  access token. Back it up somewhere safe outside Railway (a password manager, not another env
  var); losing it means every connected platform needs reconnecting.
- **`SMTP_URL` is not optional in practice.** Without it, `@nexus/mail` silently _records_ sign-in
  magic-link emails instead of sending them (`packages/mail/src/provider.ts`) — nobody would ever
  be able to log in. Get real SMTP credentials from any provider (Postmark, SES, Mailgun, etc.)
  before the first real login attempt.
- **`FEATURE_MOCK_PLATFORM=false`** — this defaults to `true` in `packages/config/src/env.ts`,
  which is correct for local dev/e2e (the mock connector is how this whole project's tests run
  without real platform credentials) but has no place in a real deployment. Set it explicitly.
- **`E2E_AUTH_BYPASS` must never be set in this environment at all.** It creates a session for any
  email with no password (`apps/web/app/api/e2e/session/route.ts`) — it's gated by the env var
  specifically so it can never activate outside test runs, but don't set it here to be certain.
- **Two DB roles**: `DATABASE_URL` should point at a lower-privilege app role (matching this
  project's own local/CI convention of `nexus_app` vs `nexus`/table-owner —
  `.github/workflows/ci.yml`'s "Create app role and shadow database" step is the reference for
  exactly what that role needs). `DATABASE_ADMIN_URL` is the table-owner role migrations run as.
  For a first deploy it's fine to point both at the same Railway-provisioned superuser connection
  string and split the roles properly once it's running — don't let this block getting live.

Platform OAuth credentials (`META_APP_ID`/`X_CLIENT_ID`/`LINKEDIN_CLIENT_ID`/etc.) are optional —
every one of them is `undefined`-safe in the schema, and a connector's own settings screen is
where you'd add them once that platform's OAuth app is registered and (where required) approved.
Don't block the first deploy on those.

`worker` additionally needs `WORKER_HEALTH_PORT` exposed if you want Railway healthchecking it
(defaults to 3001 — `packages/config/src/env.ts`).

## Build configuration (Railway dashboard, per service)

Neither `web` nor `worker` needs a committed `railway.json` — set these two fields directly on
each service in the Railway dashboard (Settings → Build):

- **`web`**: Root Directory `/` (repo root — the Dockerfile needs the whole workspace as build
  context, see the comment at the top of `apps/web/Dockerfile`), Dockerfile Path
  `apps/web/Dockerfile`.
- **`worker`**: Root Directory `/`, Dockerfile Path `apps/worker/Dockerfile`.

## First-deploy order of operations

1. Create `postgres` (pgvector image) and `redis`. Note their connection strings.
2. Set up object storage (R2 or S3), note the four `S3_*` values.
3. Generate `AUTH_SECRET` and `ENCRYPTION_KEY_FALLBACK` (`openssl rand -base64 32`, twice).
4. Get real SMTP credentials.
5. Create the `web` and `worker` services from this repo, set every env var above on both.
6. Deploy `web` first. It will fail to boot until migrations have run (empty database) — that's
   expected for this first deploy.
7. Run migrations once, against `DATABASE_ADMIN_URL`: `pnpm db:deploy` (this repo's own script,
   `packages/db`'s `migrate:deploy`). Easiest one-off ways to run this against the Railway
   database: `railway run pnpm db:deploy` from the CLI with the project linked, or a Railway
   "one-off command" from the dashboard. Do this once, not on every deploy, until a proper
   release-command hook is wired up.
8. Deploy `worker`.
9. Point your GoDaddy domain at `web`: in Railway, add the custom domain to the `web` service —
   it gives you a CNAME target. In GoDaddy's DNS management for the domain, add a CNAME record
   (or Railway may ask for an A/ALIAS record for an apex domain — follow whichever Railway's UI
   shows for the exact record type). Railway issues its own TLS certificate automatically once
   DNS resolves.
10. Update `APP_URL` on both services to the real domain once DNS is live, and redeploy.
11. Sign in once as the first user, create the workspace, invite the rest of the company.

## Known, disclosed gap: not a deploy blocker

Lighthouse CI's `largest-contentful-paint` budget (2000ms) genuinely fails in this repo's CI —
confirmed by a real, clean 3-run Lighthouse collection (~2.5-3.1s LCP on the records grid and
inbox routes). See `docs/PROGRESS.md`'s "Performance budgets" section. This is real product
performance work, tracked separately, and does not block deploying — Railway's own infrastructure
may well perform differently than the GitHub Actions shared runner Lighthouse ran against.
