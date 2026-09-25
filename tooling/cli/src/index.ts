#!/usr/bin/env tsx
/**
 * `pnpm nexus <command>` — the operator CLI (spec §4.1 replay, §9.2 DLQ replay, §7.5
 * new-connector). Commands run the engine inline in this process against the configured
 * database; with `--via-redis` they enqueue to the worker instead.
 *
 *   nexus replay --workspace <id> --connection <id> [--from-stage normalize|materialize] [--since <ISO>]
 *   nexus dlq list [--workspace <id>] [--connection <id>] [--all]
 *   nexus dlq replay <id> --workspace <id>
 *   nexus sync --workspace <id> --connection <id> [--resource <id>] [--backfill]
 *   nexus sweep-tokens
 *   nexus rescore [--workspace <id>]
 *   nexus new-connector <name> [--platform <PLATFORM>] [--display "<Name>"]
 */
import { loadEnv, QUEUES } from '@nexus/config';
import { listDeadLetters, systemActorFor, runtime } from '@nexus/db';
import { createLogger } from '@nexus/telemetry';
import {
  createInlineBus,
  createSyncDeps,
  deadLetterJob,
  enqueueBackfill,
  enqueueDelta,
  handleJob,
  replayConnection,
  replayDeadLetter,
  runIdentityRescore,
  sdkLoggerFrom,
  sweepTokens,
  type InlineBus,
  type SyncDeps,
} from '@nexus/sync';
import { scaffoldConnector } from './new-connector.ts';

type Args = { _: string[]; flags: Record<string, string | boolean> };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i += 1;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

function need(args: Args, flag: string): string {
  const v = args.flags[flag];
  if (typeof v !== 'string' || !v) throw new Error(`--${flag} is required`);
  return v;
}

async function deps(): Promise<SyncDeps & { bus: InlineBus }> {
  const env = loadEnv();
  const logger = sdkLoggerFrom(
    createLogger({ name: 'nexus-cli', level: env.LOG_LEVEL, pretty: true }),
  );
  const holder: { d: SyncDeps | null } = { d: null };
  const bus = createInlineBus({
    handlers: {
      [QUEUES.syncBackfill]: (j) => handleJob(holder.d!, j),
      [QUEUES.syncDelta]: (j) => handleJob(holder.d!, j),
      [QUEUES.ingestRaw]: (j) => handleJob(holder.d!, j),
      [QUEUES.normalize]: (j) => handleJob(holder.d!, j),
      [QUEUES.outbound]: (j) => handleJob(holder.d!, j),
    },
    onDeadLetter: (job, error) => deadLetterJob(holder.d!, job, error),
    logger,
    concurrency: 4,
  });
  holder.d = createSyncDeps({ env, bus, logger, runtime });
  return { ...holder.d, bus };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, sub] = args._;
  switch (cmd) {
    case 'replay': {
      const d = await deps();
      const stage = (args.flags['from-stage'] as string | undefined) ?? 'normalize';
      if (stage !== 'normalize' && stage !== 'materialize')
        throw new Error('--from-stage must be normalize or materialize');
      const since = typeof args.flags.since === 'string' ? new Date(args.flags.since) : null;
      const r = await replayConnection(d, {
        workspaceId: need(args, 'workspace'),
        connectionId: need(args, 'connection'),
        fromStage: stage,
        since,
      });
      console.warn(`replay queued: ${r.objects} objects in ${r.jobs} jobs; running inline…`);
      await d.bus.drain();
      console.warn(`done: ${JSON.stringify(d.bus.stats)}`);
      return 0;
    }
    case 'dlq': {
      const d = await deps();
      if (sub === 'list') {
        const workspaceId = typeof args.flags.workspace === 'string' ? args.flags.workspace : null;
        if (!workspaceId) throw new Error('--workspace is required (dead letters are tenant rows)');
        const rows = await d.runtime.withTenant(systemActorFor(workspaceId), (db) =>
          listDeadLetters(db, {
            connectionId:
              typeof args.flags.connection === 'string' ? args.flags.connection : undefined,
            includeReplayed: Boolean(args.flags.all),
          }),
        );
        for (const r of rows)
          console.warn(
            `${r.id}  ${r.failedAt.toISOString()}  ${r.queue}/${r.jobName}  ${r.errorClass}  ${r.errorMessage.slice(0, 80)}${r.replayedAt ? '  (replayed)' : ''}`,
          );
        console.warn(`${rows.length} dead letter(s)`);
        return 0;
      }
      if (sub === 'replay') {
        const id = args._[2];
        if (!id) throw new Error('usage: nexus dlq replay <id> --workspace <id>');
        const r = await replayDeadLetter(d, { workspaceId: need(args, 'workspace'), id });
        console.warn(`replayed as job ${r.jobId}; running inline…`);
        await d.bus.drain();
        console.warn(`done: ${JSON.stringify(d.bus.stats)}`);
        return 0;
      }
      throw new Error('usage: nexus dlq list|replay');
    }
    case 'sync': {
      const d = await deps();
      const workspaceId = need(args, 'workspace');
      const connectionId = need(args, 'connection');
      const c = await d.runtime.withTenant(systemActorFor(workspaceId, connectionId), (db) =>
        db.connection.findUniqueOrThrow({ where: { id: connectionId } }),
      );
      const resource = typeof args.flags.resource === 'string' ? args.flags.resource : undefined;
      if (args.flags.backfill)
        await enqueueBackfill(d, {
          workspaceId,
          connectionId,
          platform: c.platform,
          resources: resource ? [resource] : undefined,
        });
      else {
        const resources = resource
          ? [resource]
          : d.registry
              .get(c.platform)
              .listResources()
              .map((r) => r.id);
        for (const r of resources)
          await enqueueDelta(d, { workspaceId, connectionId, platform: c.platform, resource: r });
      }
      await d.bus.drain();
      console.warn(`done: ${JSON.stringify(d.bus.stats)}`);
      return 0;
    }
    case 'sweep-tokens': {
      const d = await deps();
      console.warn(JSON.stringify(await sweepTokens(d)));
      return 0;
    }
    case 'rescore': {
      const d = await deps();
      const workspaceId =
        typeof args.flags.workspace === 'string' ? args.flags.workspace : undefined;
      console.warn(JSON.stringify(await runIdentityRescore(d, workspaceId ? { workspaceId } : {})));
      return 0;
    }
    case 'new-connector': {
      const name = sub;
      if (!name)
        throw new Error('usage: nexus new-connector <name> [--platform X] [--display "Name"]');
      const files = scaffoldConnector({
        name,
        platform: typeof args.flags.platform === 'string' ? args.flags.platform : undefined,
        displayName: typeof args.flags.display === 'string' ? args.flags.display : undefined,
        rootDir: process.cwd(),
      });
      for (const f of files) console.warn(`created ${f}`);
      console.warn(`next: pnpm install && pnpm --filter @nexus/connector-${name} test`);
      return 0;
    }
    default:
      console.error('usage: nexus replay|dlq|sync|sweep-tokens|rescore|new-connector …');
      return 2;
  }
}

if (process.argv[1] && /index\.ts$/.test(process.argv[1]) && !process.env['NEXUS_CLI_NO_MAIN']) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
