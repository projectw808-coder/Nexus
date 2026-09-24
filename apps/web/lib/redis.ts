import { loadEnv } from '@nexus/config';
import IORedis from 'ioredis';

// Cached on globalThis so Next's dev HMR does not open a new connection per reload.
const g = globalThis as unknown as { __nexusRedis?: IORedis };

export function getRedis(): IORedis {
  if (!g.__nexusRedis) {
    const env = loadEnv();
    g.__nexusRedis = new IORedis(env.REDIS_URL, {
      // BullMQ requires this to be null for blocking commands.
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableReadyCheck: true,
    });
    g.__nexusRedis.on('error', (e: Error) => {
      console.error('[redis]', e.message);
    });
  }
  return g.__nexusRedis;
}

export async function checkRedis(): Promise<
  { ok: true; latencyMs: number } | { ok: false; error: string }
> {
  const started = performance.now();
  try {
    const pong = await Promise.race([
      getRedis().ping(),
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
