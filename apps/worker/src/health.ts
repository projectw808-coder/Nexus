import { createServer, type Server } from 'node:http';
import { checkDatabase } from '@nexus/db';
import type { Logger } from '@nexus/telemetry';
import type { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { checkRedis } from './redis.ts';

const bootedAt = Date.now();

/** Tiny HTTP server exposing /healthz for orchestrators and the health console. */
export function startHealthServer(opts: {
  port: number;
  redis: IORedis;
  workers: Record<string, Worker>;
  log: Logger;
}): { close: () => Promise<void>; server: Server } {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/healthz' && path !== '/readyz') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const [db, redis] = await Promise.all([checkDatabase(), checkRedis(opts.redis)]);
      const workers = Object.fromEntries(
        Object.entries(opts.workers).map(([q, w]) => [
          q,
          { running: w.isRunning(), paused: w.isPaused() },
        ]),
      );
      const ok = db.ok && redis.ok && Object.values(workers).every((w) => w.running);
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          status: ok ? 'ok' : 'degraded',
          service: 'nexus-worker',
          uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
          checks: { db, redis },
          workers,
        }),
      );
    })().catch((e: unknown) => {
      opts.log.error({ err: e }, 'health handler failed');
      res.writeHead(500);
      res.end();
    });
  });
  server.listen(opts.port, () => opts.log.info({ port: opts.port }, 'health server listening'));
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
