import { checkDatabase } from '@nexus/db';
import { currentTraceIds } from '@nexus/telemetry';
import { checkRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

const bootedAt = Date.now();

/**
 * Liveness + readiness in one. 200 when every dependency answers, 503 otherwise, always with
 * the per-check detail so the status page and an orchestrator see the same truth.
 */
export async function GET(): Promise<Response> {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const ok = db.ok && redis.ok;
  return Response.json(
    {
      status: ok ? 'ok' : 'degraded',
      service: 'nexus-web',
      version: process.env['npm_package_version'] ?? '0.0.0',
      uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
      checks: { db, redis },
      traceId: currentTraceIds()?.traceId ?? null,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
