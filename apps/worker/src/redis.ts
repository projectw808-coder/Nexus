import IORedis from 'ioredis';

export function createRedis(url: string): IORedis {
  return new IORedis(url, {
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export async function checkRedis(
  redis: IORedis,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = performance.now();
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout after 2000ms')), 2000),
      ),
    ]);
    if (pong !== 'PONG') return { ok: false, error: `unexpected reply ${String(pong)}` };
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
