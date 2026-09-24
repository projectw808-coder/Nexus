# ADR-012 — End-to-end tests sign in through a flag-gated session endpoint

**Status:** accepted (Phase 3) · **Spec:** §15 testing, §16 Phase 3 acceptance

## Context

Playwright must act as two users (an owner and a viewer) without a mailbox. Magic-link sign-in
needs an SMTP sink; Microsoft Entra needs a tenant. Neither is available on the build machine or
in CI, and the acceptance criteria (60 fps on 100k rows, keyboard reachability, axe) are about
the screens, not the sign-in.

## Decision

`GET /api/e2e/session?email=&next=` creates a database session for the user (creating the user
if missing) and sets the Auth.js session cookie, then redirects. It is honoured only when the
`E2E_AUTH_BYPASS` environment variable is `true`; otherwise it returns 404 like any unknown
route. The env schema defaults it to `false` and treats blanks as unset. The Playwright config
sets it for its own `next start` on port 3200 with a PGlite database seeded by
`packages/db/src/testing/seed-e2e.ts` (owner, viewer, a `widget` object with 100,000 rows
inserted in SQL, six deals in the pipeline).

The gate is the flag alone, not `NODE_ENV`: the e2e run exercises the production build, so a
`NODE_ENV !== 'production'` guard would defeat the test.

## Consequences

- Production must never set `E2E_AUTH_BYPASS`. The deploy checklist and `.env.example` say so.
- Tests are hermetic and fast; the same seed runs on the CI pgvector service by pointing
  `DATABASE_URL` at it.
- Security review item: an operator who sets the flag in production opens unauthenticated
  sign-in as any email. That is the same class of risk as leaking `AUTH_SECRET` and is treated
  the same way (never in production config, alerted if present).
