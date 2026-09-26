/**
 * @nexus/api — the public REST v1 contract (spec §11.2, ADR-022 decision 2).
 *
 * Schemas only: the Zod schemas the route handlers in `apps/web/app/api/v1/**` validate with,
 * and the OpenAPI 3.1 document generated from those same schemas. No route handlers and no auth
 * live here by design — the contract is a separate artefact from the transport that serves it.
 */
export { generateOpenApiDocument, REST_V1_VERSION, REST_V1_SERVER_URL } from './registry.ts';
export * from './schemas.ts';
