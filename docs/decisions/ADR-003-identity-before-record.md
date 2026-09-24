# ADR-003 — Where data lands before identity resolves

**Status:** accepted (Phase 0) · **Spec:** §6.6 decision 3 — resolves a contradiction with decision 2

## Context

Stage 5 (materialize) must not wait for stage 4 (resolve). §6.6(3) says a `Conversation` and a
`TimelineEvent` attach to the `Identity` immediately and to a `Record` once resolved. §6.6(2) says
`TimelineEvent.recordId` "stays non-nullable". Both cannot hold.

## Decision

`TimelineEvent.recordId` and `Conversation.personRecordId` are **nullable**; both models carry a
nullable `identityId`. Indexes exist on `[workspaceId, recordId, occurredAt desc]` and
`[workspaceId, identityId, occurredAt desc]`. The record timeline query unions events by `recordId`
with events whose `identityId` belongs to the record's identities. Resolution backfills `recordId`
in one batched update. ADR-002's exactness is preserved by the snapshot, not by non-nullability.

## Consequences

An unresolved identity has a viewable timeline (a product requirement, §16 Phase 6). Every timeline
reader must use the union helper in `packages/core`, never a raw `recordId` filter.
