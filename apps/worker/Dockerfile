# apps/worker — single image, runs TypeScript via tsx (no build step for workspace packages).
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter @nexus/worker...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo /repo
COPY apps/worker /repo/apps/worker
RUN pnpm --filter @nexus/db generate
WORKDIR /repo/apps/worker
EXPOSE 3001
CMD ["pnpm", "start"]
