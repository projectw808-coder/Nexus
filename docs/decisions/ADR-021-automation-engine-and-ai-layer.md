# ADR-021 — The workflow engine's dependency boundary, stage 6 ("React"), and the AI provider seam

**Status:** accepted (Phase 10) · **Spec:** §4.1 stage 6, §13, §14, §16 Phase 10 · **Builds on:** ADR-010, ADR-013, ADR-014, ADR-017

## Context

Phase 10 adds two new packages (`@nexus/automation`, `@nexus/ai`) and the pipeline's long-deferred
stage 6 ("React"). Both packages need to run inside `apps/worker` (triggered by ingest) and be
callable from `apps/web` (triggered by a human editing a record, or a manual "regenerate" click).
Left unexamined, that shape produces a dependency cycle: the sync engine would need to import the
automation engine to react to ingested events, and the automation engine's "send platform reply"
action would need to import the sync engine's `requestReply`. Four decisions remove the cycle and
fix the stage-6 hook point.

## Decisions

1. **`@nexus/automation` and `@nexus/ai` depend only on `@nexus/core` and `@nexus/db` — never on
   `@nexus/sync` or `@nexus/connector-sdk`.** Anything platform-specific an action needs (sending a
   reply, calling a webhook, sending mail) is injected as a callback on a small runtime bag the
   _caller_ constructs. `apps/worker` is the one place that imports all three packages, so it is
   the one place that wires `@nexus/sync`'s `requestReply` into `@nexus/automation`'s
   `sendReply` callback. Neither new package ever imports the other's internals; the only thing
   they share is the plain-data `AutomationEvent` shape (see decision 2), which `@nexus/sync` and
   `apps/web` both construct without needing automation's execution logic.

2. **Stage 6 is event-driven off `TimelineEvent`, not a new hook threaded through every sink.**
   `TimelineEvent` already carries `externalObjectId` with an index built for exactly this
   (`@@index([workspaceId, externalObjectId])`, present since the Phase 2 schema). After
   `stages/normalize.ts` calls `deps.sink.materialize(batch)`, it queries the `TimelineEvent`
   rows just created for this batch's object ids and enqueues one `AutomationEvent` per event onto
   `QUEUES.automate` — no sink is modified, and replaying stage 3 replays stage 6 for free.
   Record creates/updates from `apps/web`'s record router (a human edit, not an ingest event)
   construct the same `AutomationEvent` shape directly and dispatch it through the existing
   `ctx.jobs` mechanism (ADR-010), generalized from a single hardcoded `system`-queue dispatcher
   to one that routes by queue name — `index.build`/`attribute.purge` keep going to `system`,
   `automate.react` goes to the new `automate` queue.

3. **Loop detection is a causation chain carried on the event, not a static analysis of the
   workflow's own shape.** Every `AutomationEvent` carries `causation: { workflowIds: string[] }`
   (default empty). An action that performs a mutation which would itself normally re-enter stage
   6 (`update_record`, `create_record`, `list_add`, `stage_move`) is executed by
   `@nexus/automation` itself (it depends on `@nexus/db` directly for exactly this), and the
   action appends the running workflow's id to the chain before calling the injected
   `enqueueEvent` callback for the follow-on event. Before running, a workflow whose id is already
   in the incoming event's chain is halted with `WorkflowRun.status = 'CANCELLED'` and
   `error: 'loop_detected'` — matching spec §14's wording exactly ("a run that re-triggers its own
   trigger is halted and flagged") without requiring the engine to reason about a workflow's
   conditions ahead of time. A chain longer than 10 is cancelled the same way as a second line of
   defense against cross-workflow cycles (A triggers B triggers A).

4. **The AI provider is a `KeyProvider`-shaped seam** (mirrors ADR-014): an `AiModel` interface
   with `complete()` and `embed()`, a deterministic `mockAiModel()` for tests (used directly, the
   same way connector tests inject `fetch`), and thin `fetch`-based adapters for
   `AI_PROVIDER=anthropic|openai` — no SDK dependency added. `AI_PROVIDER=disabled` (the default)
   resolves to a model that throws `POLICY_BLOCKED` before any network call, so a workspace that
   never configured AI cannot accidentally spend budget. Every feature function calls
   `checkAiAllowed()` (workspace kill switch + monthly `AiUsage` sum against
   `workspace.settings.ai.monthlyTokenBudget`) **before** touching the model — this is what makes
   "the kill switch stops all model calls within one request" true: flipping the switch changes
   what the very next `checkAiAllowed()` read returns, and every call site checks it fresh, so
   nothing needs to be cancelled mid-flight.

## Other decisions of note

- **Bio-embedding, the Tier-3 signal ADR-017 deferred to "when the AI layer exists" (§10),
  is wired into the nightly identity re-score only, not the ingest-time resolver.** `scorePair`
  (`packages/core`, pure, no I/O) gains an optional `bioSimilarity` input and a `BIO_EMBEDDING`
  Tier-3 signal when it clears a similarity floor — the tiers and auto-merge threshold from §10
  are unchanged. Computing it needs a model call, and the ingest-time resolver runs per object on
  the hot path; the nightly re-score is already the place designed for "new signals arrive"
  (ADR-017 decision 5) and can afford a batched, budget-checked embedding comparison. Real-time
  resolution still runs Tier 1/2 and the non-embedding Tier-3 signals exactly as before.
- **Lead scoring makes no model call.** §13.5 requires the score be transparent and editable, so
  it is a pure weighted function over stored signals (engagement recency/frequency/depth,
  firmographics, pipeline stage) with per-workspace-editable weights in
  `workspace.settings.ai.leadScoreWeights`. It costs no tokens and needs no kill switch.
- **Round-robin assignment needs a persistent cursor** — "who got the last one" — which counting
  `WorkflowRun` rows cannot answer (it gives frequency, not order). `Workflow` gains a
  `state Json @default("{}")` column, a per-workflow scratch pad keyed by the acting action's id
  (every action in the `actions` array carries a builder-assigned `id`), so `assign(mode:
'round_robin')` can read and advance its own cursor without a new table.
- **Workflow versioning is a new `WorkflowVersion` table**, not a JSON array on `Workflow` —
  mirrors `RecordMerge`'s snapshot-and-restore shape (ADR-002) so "rollback" is "copy an old
  version's trigger/conditions/actions back onto the live row," auditable and queryable, rather
  than an opaque blob.
- **`AiInsight.kind` is not extended for "relationship brief."** The enum (`SUMMARY | SENTIMENT |
INTENT | NEXT_BEST_ACTION | CHURN_RISK | RESEARCH`) has no slot for it, and adding one for a
  single feature when `content` is already schema-flexible JSON is unnecessary. A relationship
  brief is stored as `kind: SUMMARY` with `content.kind: 'relationship_brief'`; a conversation
  summary is `content.kind: 'conversation_summary'`. Both carry `citations` pointing at real
  `TimelineEvent` ids either way, which is what the Phase 10 acceptance criterion actually checks.

## Consequences

`@nexus/sync` gains no new package dependency for stage 6 (it only enqueues plain JSON). Only
`apps/worker` and `apps/web` end up depending on all of `@nexus/automation`, `@nexus/ai` and
`@nexus/sync` together, which is exactly where DI wiring already happens (the `Notifier` pattern
from Phase 9's token sweep is the precedent). A workflow that calls another workflow
(`run_workflow` action) is subject to the same causation-chain check, so workflow-to-workflow
cycles are caught the same way as a workflow re-triggering itself.
