# apps/web — Next.js standalone output.
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile --filter @nexus/web...
# `next build` collects page data by evaluating server modules, which import packages/config's
# envSchema at module scope (server/routers/ai.ts) — it needs real values even during the build,
# not just at container runtime. Railway auto-injects configured service variables as build args,
# but a Dockerfile ARG must exist to receive each one (https://docs.railway.com/guides/dockerfiles).
ARG DATABASE_URL
ARG REDIS_URL
ARG S3_ENDPOINT
ARG S3_BUCKET
ARG S3_ACCESS_KEY
ARG S3_SECRET_KEY
ARG APP_URL
ARG AUTH_SECRET
ARG KMS_MASTER_KEY_ID
RUN pnpm --filter @nexus/db generate && pnpm --filter @nexus/web build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
