import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source (no build step).
  transpilePackages: ['@nexus/config', '@nexus/core', '@nexus/db', '@nexus/telemetry', '@nexus/ui'],
  // Native / instrumented modules must stay external so OTel can patch them and Prisma can
  // load its query engine.
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/instrumentation',
    '@opentelemetry/instrumentation-http',
    '@opentelemetry/instrumentation-ioredis',
    '@opentelemetry/instrumentation-pino',
    '@prisma/client',
    '@prisma/adapter-pg',
    'pg',
    'pino',
    'pino-pretty',
    'bullmq',
  ],
};

export default nextConfig;
