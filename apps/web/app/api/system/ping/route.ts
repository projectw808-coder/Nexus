import { currentTraceIds, injectTraceCarrier, TRACE_CARRIER_KEY } from '@nexus/telemetry';
import { getSystemQueue, getSystemQueueEvents } from '@/lib/queue';
import { checkRedis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * Phase 0 acceptance: enqueue a job carrying the current trace context and wait (briefly) for
 * the worker to finish it. The response returns the trace id so the caller can open it in
 * Jaeger and see HTTP span → queue consumer span in one trace.
 */
export async function POST(): Promise<Response> {
  // Fail fast rather than letting the enqueue wait in ioredis's offline queue forever.
  const redis = await checkRedis();
  if (!redis.ok) {
    return Response.json(
      {
        error: 'Redis is unreachable',
        detail: redis.error,
        traceId: currentTraceIds()?.traceId ?? null,
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  const queue = getSystemQueue();
  const carrier = injectTraceCarrier();
  const job = await queue.add('ping', {
    sentAt: new Date().toISOString(),
    [TRACE_CARRIER_KEY]: carrier,
  });

  let result: unknown = null;
  let state: 'completed' | 'timeout' | 'failed' = 'timeout';
  try {
    result = await job.waitUntilFinished(getSystemQueueEvents(), 5000);
    state = 'completed';
  } catch (e) {
    state = /timeout|timed out/i.test(String(e)) ? 'timeout' : 'failed';
    result = e instanceof Error ? e.message : String(e);
  }

  return Response.json(
    {
      jobId: job.id ?? null,
      state,
      result,
      traceId: currentTraceIds()?.traceId ?? null,
      traceparent: carrier['traceparent'] ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
