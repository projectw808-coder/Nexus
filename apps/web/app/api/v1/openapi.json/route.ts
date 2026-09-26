/**
 * `GET /api/v1/openapi.json` — the served OpenAPI 3.1 document (§11.2, ADR-022 decision 2).
 *
 * No authentication: a contract nobody can read is not a public API. It is generated from the
 * same Zod schemas the route handlers validate with, so "the spec generates a working client"
 * (§16 Phase 11) is a property of the code rather than a promise about it.
 */
import { generateOpenApiDocument } from '@nexus/api';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(JSON.stringify(generateOpenApiDocument()), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
    },
  });
}
