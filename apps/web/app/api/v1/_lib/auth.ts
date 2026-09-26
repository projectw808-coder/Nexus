/**
 * REST v1 authentication (§11.2, ADR-022 decision 1).
 *
 * A workspace API key, not a session: the key *is* the workspace, which is why no REST path
 * contains a workspace slug. The resolved actor is `actorType: 'API_KEY'` with `userId: null` —
 * owner-level inside its own tenant, exactly like the system actor background jobs use. CASL
 * never runs on this path; what a key may do is decided here, by its `ApiKeyScope[]`.
 */
import type { ApiKeyScope } from '@nexus/db';
import { hasApiScope, resolveApiKeyActor, type Actor } from '@nexus/db';
import type { RestDeps } from './deps.ts';
import { problemFor, problemResponse } from './problem.ts';

/**
 * The taxonomy's own AUTH_EXPIRED remediation talks about reconnecting a *platform* — right for
 * a sync failure, wrong for a bearer key, so these two cases say what the caller can actually do.
 */
const KEY_REMEDIATION =
  'Create or rotate a key under Settings → API keys, then send it as a bearer token.';

export type Authenticated = {
  workspaceId: string;
  actor: Actor;
  apiKeyId: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number | null;
};

export type AuthResult = { ok: true; auth: Authenticated } | { ok: false; response: Response };

/** `Authorization: Bearer <key>` — the only accepted form. */
export function bearerFrom(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

export async function authenticate(
  deps: RestDeps,
  req: Request,
  requiredScope: ApiKeyScope,
): Promise<AuthResult> {
  const presented = bearerFrom(req);
  if (!presented) {
    return {
      ok: false,
      response: problemResponse(
        problemFor(
          'AUTH_EXPIRED',
          'Send a workspace API key as `Authorization: Bearer nx_live_…`.',
          { remediation: KEY_REMEDIATION },
        ),
        { 'www-authenticate': 'Bearer realm="Nexus REST v1"' },
      ),
    };
  }
  const resolved = await resolveApiKeyActor(deps.runtime, presented);
  if (!resolved) {
    // Unknown, revoked and expired are deliberately indistinguishable.
    return {
      ok: false,
      response: problemResponse(
        problemFor('AUTH_EXPIRED', 'That API key is unknown, revoked or expired.', {
          remediation: KEY_REMEDIATION,
        }),
        { 'www-authenticate': 'Bearer realm="Nexus REST v1", error="invalid_token"' },
      ),
    };
  }
  if (!hasApiScope(resolved.scopes, requiredScope)) {
    return {
      ok: false,
      response: problemResponse(
        problemFor(
          'FORBIDDEN',
          `This key holds ${resolved.scopes.join(', ')}; the operation needs ${requiredScope}.`,
          {
            remediation:
              `Use a key whose scopes cover ${requiredScope} — WRITE implies READ and ADMIN ` +
              'implies both. Keys are managed under Settings → API keys.',
          },
        ),
      ),
    };
  }
  return { ok: true, auth: resolved };
}
