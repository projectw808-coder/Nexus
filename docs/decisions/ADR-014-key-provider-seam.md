# ADR-014 — Envelope encryption behind a `KeyProvider`; the local provider is dev/test only

**Status:** accepted (Phase 4) · **Spec:** §5.4 secrets and tokens, §18 env

## Context

§5.4 mandates AES-256-GCM with a per-workspace data key wrapped by a KMS master key. The build
and CI machines have no cloud KMS, and the repository must not depend on a cloud SDK to run its
tests.

## Decision

- `packages/connectors/sdk/src/runtime/envelope.ts` implements the cryptography: 32-byte data
  keys, AES-256-GCM with a 12-byte IV, the auth tag, and AAD binding each blob to
  `vault:<workspaceId>:<entryId>` so a blob copied to another row or tenant fails to decrypt.
- The master key is behind `KeyProvider { wrapDataKey, unwrapDataKey }`. `localKeyProvider`
  serves `KMS_MASTER_KEY_ID=local:*` from `ENCRYPTION_KEY_FALLBACK` and refuses any other id;
  `keyProviderFromEnv` throws for a non-local id until a cloud provider registers there. There
  is no silent plaintext or fallback path.
- `WorkspaceKey` rows hold wrapped data keys with `masterKeyId`; several versions may coexist
  while a master key rotates. `VaultEntry` rows hold `{ciphertext, iv, tag}` plus the key id
  and a rotation counter. The vault (`packages/db/src/vault.ts`) exposes `put`/`get`/`rotate`/
  `revoke`; `revoke` also blanks the ciphertext. No tRPC procedure or route returns a secret.

## Consequences

- Production deployments must supply a cloud KMS provider (planned with the Terraform skeleton
  in Phase 11) and a non-`local:` key id; the process refuses to start otherwise.
- Rotating the master key is: add the new provider version, create a new `WorkspaceKey` per
  tenant on next write, re-wrap old keys in a batch job. Entries never need re-encryption.
