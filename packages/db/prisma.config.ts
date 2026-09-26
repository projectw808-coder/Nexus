import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The repo-root .env is the single source for local settings (packages/config validates it at
// boot). `prisma generate` needs no database but Prisma 7 still requires a URL here, so fall back
// to the docker-compose default rather than failing a CI step that only generates the client.
loadDotenv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
// Migrations run as the table owner; the app role in DATABASE_URL is deliberately weaker.
const url =
  process.env['DATABASE_ADMIN_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://nexus:nexus@localhost:5432/nexus';
// Prisma 7 moved shadow-database configuration off the `migrate diff --shadow-database-url` CLI
// flag (removed) and onto this config; scripts/drift-gate.ts relies on it.
const shadowDatabaseUrl = process.env['SHADOW_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: { url, ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) },
});
