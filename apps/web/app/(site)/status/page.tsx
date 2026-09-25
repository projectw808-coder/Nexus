import { checkDatabase } from '@nexus/db';
import { loadEnv } from '@nexus/config';
import { checkRedis } from '@/lib/redis';
import { TracePing } from '@/components/trace-ping';

export const dynamic = 'force-dynamic';

type Check = { ok: true; latencyMs: number } | { ok: false; error: string };

function StatusPill({ check, label }: { check: Check; label: string }) {
  // Status is never colour alone (§12.3): icon + text accompany the tone.
  const tone = check.ok ? 'good' : 'critical';
  return (
    <li className="flex items-center justify-between rounded-[var(--radius-card)] border border-hairline bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="inline-block size-2.5 rounded-full"
          style={{ background: `var(--status-${tone})` }}
        />
        <span className="font-medium">{label}</span>
      </div>
      <span className="tnum text-[var(--text-sm)] text-ink-secondary">
        {check.ok ? (
          <>
            <span className="sr-only">healthy, </span>
            {check.latencyMs} ms
          </>
        ) : (
          <>
            <span className="font-medium text-[var(--status-critical)]">Down</span>
            <span className="ml-2">{check.error}</span>
          </>
        )}
      </span>
    </li>
  );
}

export default async function StatusPage() {
  const env = loadEnv();
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const allGood = db.ok && redis.ok;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">Foundation</h1>
        <p className="mt-1 max-w-prose text-ink-secondary">
          Phase 0 of Nexus: infrastructure, tracing, tokens. Everything below is live data from this
          process.
        </p>
      </section>

      <section aria-labelledby="deps">
        <h2
          id="deps"
          className="mb-3 text-[var(--text-sm)] font-medium uppercase tracking-wide text-ink-muted"
        >
          Dependencies
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          <StatusPill label="PostgreSQL" check={db} />
          <StatusPill label="Redis" check={redis} />
        </ul>
        <p className="mt-2 text-[var(--text-sm)] text-ink-muted">
          {allGood
            ? 'Everything is fine.'
            : 'Start the local stack with `pnpm infra:up` (Docker) and reload.'}
        </p>
      </section>

      <section aria-labelledby="trace">
        <h2
          id="trace"
          className="mb-3 text-[var(--text-sm)] font-medium uppercase tracking-wide text-ink-muted"
        >
          Trace end to end
        </h2>
        <TracePing
          jaegerBase={env.OTEL_EXPORTER_OTLP_ENDPOINT ? 'http://localhost:16686' : null}
          disabled={!redis.ok}
        />
      </section>
    </div>
  );
}
