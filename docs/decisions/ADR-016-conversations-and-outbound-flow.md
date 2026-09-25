# ADR-016 — Conversations materialise from the sink; outbound sends carry a per-intent nonce

**Status:** accepted (Phase 5) · **Spec:** §6.3, §6.4 idempotency, §8.1, §9.3, §16 Phase 5

## Context

Phase 5's acceptance needs a DM to land as `Conversation` + `Message` rows and a reply to
reach the platform, before identity resolution (Phase 6) and the full inbox (Phase 7) exist.
Meta also needs one connector to serve two platforms, and its messaging window must be enforced
before a send is queued.

## Decision

- **Conversation sink.** `createConversationSink` (ADR-013 seam) upserts `Identity`,
  `Conversation` and `Message` rows from canonical persons, conversations and messages, keyed by
  platform ids so replays and redeliveries are no-ops. A message may create its thread. Identity
  → Person stays unresolved (`personRecordId` null) until Phase 6; the inbox shows the identity.
- **Outbound flow.** `requestReply` builds the `OutboundActionInput` with the §6.4 key
  `sha256(connectionId, kind, conversationId, sha256(content), requestNonce)`; the nonce is minted
  by the composer once per draft and replayed on retry, so a double-submit collapses to one send
  while a deliberate repeat goes through. `preflight()` runs first; a refusal is recorded as a
  BLOCKED action with the code and reason and never reaches the queue. Accepted actions run on
  the `outbound` queue, persist `externalId`, write the outbound `Message` row and audit
  `outbound.sent` as the requesting user.
- **`OutboundActionInput.context`.** Core passes thread facts (`lastInboundAt`,
  `conversationKind`) so a connector's preflight can apply window rules without I/O.
- **One connector, two platforms.** The registry maps both `FACEBOOK` and `INSTAGRAM` to the
  Meta connector; the account's platform comes from discovery, resource ids are prefixed
  (`fb.` / `ig.`) and `resourcesFor()` selects the ones that apply. `DiscoveredAccount.token`
  lets the connector hand core the Page token so each connection vaults its own credential.
- **Version drift.** `manifest.apiVersionHeader` names the header core compares with the
  pinned version on every response; the weekly monitor opens an upgrade task inside 180 days.

## Consequences

- Phase 7 builds the inbox on these rows and this flow; Phase 6 attaches persons to the
  identities the sink already created.
- Platform echoes of our own sends (Meta `is_echo`) arrive with their own message id and are
  stored as a second outbound row; Phase 7 collapses them onto the `OutboundAction` when the
  platform returns a matching id.
