/**
 * The one place `zod` is extended with `.openapi()`.
 *
 * `@asteasolutions/zod-to-openapi` patches Zod's prototype, so the patch must be applied
 * before any schema calls `.openapi()`. Every module in this package imports this one first
 * (and nothing else imports it), which makes the ordering a property of the import graph
 * rather than something a reader has to remember.
 *
 * Zod 4 compatibility: zod-to-openapi v9 declares `zod: ^4.0.0` as its peer and stores
 * metadata in Zod 4's own `$ZodRegistry`, so `^4.6.5` (this monorepo's version) is supported
 * natively — no shim and no downgrade.
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export { z };
