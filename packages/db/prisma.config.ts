import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The repo-root .env is the single source for local settings (packages/config validates it at
// boot). `prisma generate` needs no database but Prisma 7 still requires a URL here, so fall back
// to the docker-compose default rather than failing a CI step that only generates the client.
loadDotenv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
const url = process.env['DATABASE_URL'] ?? 'postgresql://nexus:nexus@localhost:5432/nexus';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: { url },
});
