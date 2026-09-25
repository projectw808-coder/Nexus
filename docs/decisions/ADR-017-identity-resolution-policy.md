# ADR-017 — Identity resolution policy: where suggestions live, when a person is created, what "verified" means

**Status:** accepted (Phase 6) · **Spec:** §10, §6.3, §6.6(3), §16 Phase 6 · **Builds on:** ADR-002, ADR-003

## Context

§10 fixes the tiers, the thresholds and the auto-merge rule, and says everything weaker
"becomes a `MergeSuggestion`". The schema's `MergeSuggestion` is a record↔record pair, but most
of what the resolver scores is an unresolved **identity** against a person: a commenter, a lead
form, a DM sender. Three things had to be decided: where an identity↔person suggestion is stored,
what happens to an identity that matches nobody, and what "most recent verified wins" means for
field survivorship when no per-field verification exists yet.

## Decision

1. **One queue, two subjects.** `MergeSuggestion` gains a nullable `identityId` and
   `leftRecordId` becomes nullable; exactly one of them is set (enforced in code, unique on
   `(workspaceId, identityId, rightRecordId)`). Accepting an identity suggestion links the
   identity (`IdentityLink` with the suggestion's signals as evidence, confirmed by the reviewer);
   accepting a record suggestion merges (ADR-002). Rejecting a record pair writes `NeverMerge`;
   rejecting an identity pair is remembered on the suggestion itself, and the resolver skips
   REJECTED targets for that identity. No "shadow person" is created just to file a suggestion.
2. **Anchored identities become people; unanchored ones wait.** An identity whose best candidate
   clears the §10 auto rule (≥ 0.9 and ≥ 1 Tier-1 or ≥ 2 Tier-2 signals) is linked at once. One
   with a candidate ≥ 0.4 is filed for review. One with **no** candidate but a deterministic
   anchor (e-mail or phone) becomes a new Person, linked with that anchor as the method. One with
   neither stays unresolved: its conversations and timeline events live on the identity (ADR-003),
   are visible on its own page, and move to a Person in one batched update when it resolves —
   never copied. Lead-form submissions carry no platform user id, so they get a synthetic identity
   keyed `lead:<leadId>` on the platform so the form's e-mail/phone can resolve them.
3. **Survivorship uses `updatedAt` as the verification proxy.** A value the winner lacks is taken
   from the loser. Where both have a value and they differ, the record updated more recently wins
   and the other value is kept in the merge snapshot; `alternatesFor` surfaces it in the field's
   history popover. When per-field verification exists (Phase 11 data-subject workflows), it
   replaces the proxy without changing the snapshot format. `_unmapped` bags are unioned.
4. **Unmerge restores exactly, except a later edit.** A field is restored only if its current
   value still equals the merged-in value, so an edit made after the merge survives. Rows created
   on the winner after the merge stay with the winner (ADR-002). The merge's own SYSTEM timeline
   event is deleted on unmerge; unmerge writes an audit row, not a timeline event, so the timeline
   matches the pre-merge snapshot. A `NeverMerge` pair is written unless the caller opts out.
5. **The nightly job re-scores suggestions first**, then unresolved identities, then people
   touched in the last day — so new evidence promotes a waiting suggestion instead of expiring it
   through a fresh link.
6. **Idempotent timeline.** `TimelineEvent.dedupeKey` (unique per workspace) is built from the
   connection and the platform id, so replays and webhook redeliveries are no-ops; `Identity`
   gets `resolutionAttemptedAt` so the nightly pass is bounded.

## Signals not computed yet

Avatar perceptual hashes need the media pipeline (fetch and store, never hotlink — §8.7), which
lands with the integrations hub in Phase 9; bio embeddings need the AI layer (Phase 10). Both slot
into `scorePair` as Tier-3 signals when they exist; the tiers and thresholds do not change.

## Consequences

The review queue mixes "is @handle this person?" with "are these two people the same?", which is
what a reviewer actually faces. People are created only from deterministic anchors, so a backfill
of ten thousand commenters does not create ten thousand contacts. Every automatic decision is
readable back from the "why" panel, and every one is audited as SYSTEM.
