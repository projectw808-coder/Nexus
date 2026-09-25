# ADR-018 — Inbox realtime over NOTIFY → SSE, the SLA clock, and where inbox views live

**Status:** accepted (Phase 7) · **Spec:** §4 (realtime), §12.2.A, §16 Phase 7 · **Builds on:** ADR-010, ADR-016

## Context

The inbox must show a teammate's assignment, a customer's new message and a sent reply without a
reload, on a laptop with no Redis (ADR-010) and in production with several web processes. The
spec fixes the transport — Postgres `LISTEN/NOTIFY` bridged to Server-Sent Events — and asks for
SLA timers, snooze and saved filter views without saying where their state lives.

## Decision

1. **Events are published inside the writing transaction** with `pg_notify`, so a change that
   rolls back is never announced and a subscriber never refetches ahead of the commit. Payloads
   carry ids and a topic (`conversation.changed`, `timeline.changed`), never row contents;
   clients invalidate and refetch through tRPC, so the SSE path needs no authorization of its
   own beyond membership in the workspace it streams. One LISTEN connection per process
   (PGlite's in-process `listen()` on a developer machine, a dedicated `pg` client otherwise)
   fans out to every SSE stream in memory. `GET /api/events?workspace=<slug>` checks the
   session and membership, filters by workspace and heartbeats every 25 s.
2. **The SLA clock is a column, not a job.** An inbound message on a thread with no running
   clock sets `slaDueAt = sentAt + target`, where the target is the connection's
   `slaTargetMinutes`, else the workspace's `settings.inbox.slaTargetMinutes`, else 60 minutes
   (`null` on the workspace switches SLAs off). Any outbound reply clears the clock and records
   `firstResponseAt` once. "Breached" and "due soon" are therefore plain comparisons the list
   filters on with the `(workspaceId, slaDueAt)` index, and a breach is an automation trigger
   (Phase 10) rather than a stored flag.
3. **Snooze is a status.** `SNOOZED` with `snoozedUntil`; a minute-level system job reopens
   expired snoozes, and a customer writing again reopens a snoozed or closed thread at once.
4. **Inbox views are `SavedView` rows with neither object nor list**, and `filters` holds the
   conversation filter state as an object instead of record filters. One model, one sharing
   rule (mine or shared), one router.
5. **Canned replies are a small tenant model** (`CannedReply`: title, body, optional unique
   `/shortcut`, optional platform), picked from the composer or expanded when the shortcut is
   typed. Members create and edit; managers delete.
6. **Internal notes are `Note` rows on the conversation**, interleaved with messages in the
   thread; `@mentions` are validated member ids kept in `bodyJson.mentions`. When the thread's
   identity is resolved, the note is also a NOTE event on the person's timeline.
7. **The mock platform is hosted by the app under `E2E_AUTH_BYPASS`** at `/api/e2e/mock`, with an
   `/oauth/authorize` redirect and an `_emit` endpoint, so the §15 browser path (connect →
   backfill → webhook → reply → resolve → timeline) runs against a real HTTP round trip and the
   real webhook route, with nothing mocked inside the app.

## Not in this phase

AI drafts and the relationship brief in the sidebar (Phase 10), sentiment filters (Phase 10),
attachments on outbound messages (the composer states what each platform accepts; Meta is text
only until the media pipeline in Phase 9), sending as a different connected account on the same
thread (only meaningful once X mentions land in Phase 8), and email quoted-reply collapsing
(Gmail, Phase 8).

## Consequences

Realtime works identically on PGlite and Postgres. The inbox list is one indexed query plus
three counts; with 50,000 conversations it stays under the 500 ms p95 on PGlite. SLA state is
consistent even if the worker is down, because the clock is set by the sink that writes the
message. Saved inbox views share the record views' sharing semantics and permissions.
