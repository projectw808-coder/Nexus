/**
 * Realtime events (spec §4 "Postgres LISTEN/NOTIFY → SSE bridge", §12.2.A). Writers call
 * `publishEvent` inside their tenant transaction; Postgres delivers the notification at commit,
 * so a subscriber never sees an event for a change that rolled back. Readers subscribe once per
 * process and fan out in memory: the web tier turns them into Server-Sent Events, filtered by
 * workspace.
 *
 * Backends: the `pg` driver holds one dedicated LISTEN connection; PGlite uses its in-process
 * `listen()`. Payloads are small (ids and a topic) — clients refetch what changed.
 */
import { EventEmitter } from 'node:events';
import { Prisma } from './generated/prisma/client.ts';
import { getRegisteredPglite } from './ddl.ts';
import type { SystemDb, TenantDb } from './scoped.ts';

export const EVENTS_CHANNEL = 'nexus_events';

export type NexusEvent = {
  workspaceId: string;
  /** Dotted topic, e.g. `conversation.changed`, `timeline.changed`, `identity.changed`. */
  topic: string;
  /** Ids the client should refetch; never row contents. */
  payload: Record<string, unknown>;
  at: string;
};

type Db = Pick<TenantDb | SystemDb, '$executeRaw'>;

/** Publish from inside a transaction; delivered when it commits. */
export async function publishEvent(
  db: Db,
  event: Omit<NexusEvent, 'at'> & { at?: string },
): Promise<void> {
  const full: NexusEvent = { ...event, at: event.at ?? new Date().toISOString() };
  // pg_notify payloads are limited to 8000 bytes; ours are ids only.
  await db.$executeRaw(Prisma.sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(full)})`);
}

const g = globalThis as {
  __nexusEvents?: EventEmitter;
  __nexusListener?: Promise<() => Promise<void>>;
};

function emitter(): EventEmitter {
  if (!g.__nexusEvents) {
    g.__nexusEvents = new EventEmitter();
    g.__nexusEvents.setMaxListeners(1_000);
  }
  return g.__nexusEvents;
}

async function ensureListener(): Promise<void> {
  g.__nexusListener ??= (async () => {
    const em = emitter();
    const deliver = (raw: string | null | undefined) => {
      if (!raw) return;
      try {
        em.emit('event', JSON.parse(raw) as NexusEvent);
      } catch {
        /* a foreign notification on our channel: ignore */
      }
    };
    const pglite = getRegisteredPglite();
    if (pglite) {
      const unlisten = await pglite.listen(EVENTS_CHANNEL, deliver);
      return async () => {
        await unlisten();
      };
    }
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    client.on('notification', (n) => {
      if (n.channel === EVENTS_CHANNEL) deliver(n.payload);
    });
    client.on('error', () => {
      // A dropped LISTEN connection is re-established on the next subscribe.
      g.__nexusListener = undefined;
    });
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    return async () => {
      await client.end();
    };
  })();
  await g.__nexusListener;
}

/** Subscribe to every event in this database; returns the unsubscribe function. */
export async function subscribeEvents(
  handler: (event: NexusEvent) => void,
  filter?: { workspaceId?: string; topics?: string[] },
): Promise<() => void> {
  await ensureListener();
  const em = emitter();
  const wrapped = (e: NexusEvent) => {
    if (filter?.workspaceId && e.workspaceId !== filter.workspaceId) return;
    if (filter?.topics?.length && !filter.topics.includes(e.topic)) return;
    handler(e);
  };
  em.on('event', wrapped);
  return () => {
    em.off('event', wrapped);
  };
}

/** Tests and shutdown: drop the LISTEN connection. */
export async function closeEventListener(): Promise<void> {
  const l = g.__nexusListener;
  g.__nexusListener = undefined;
  if (l) await (await l)();
}
