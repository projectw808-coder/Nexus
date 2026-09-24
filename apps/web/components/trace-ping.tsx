'use client';

import { useState } from 'react';

type PingResponse = {
  jobId: string | null;
  state: 'completed' | 'timeout' | 'failed';
  result: unknown;
  traceId: string | null;
};

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; data: PingResponse }
  | { kind: 'error'; message: string };

/**
 * Sends one job through Redis to the worker and shows the trace id that both spans share.
 * Idle, loading, error and result states are all rendered (§0.8).
 */
export function TracePing({
  jaegerBase,
  disabled,
}: {
  jaegerBase: string | null;
  disabled: boolean;
}) {
  const [view, setView] = useState<View>({ kind: 'idle' });

  const send = async () => {
    setView({ kind: 'loading' });
    try {
      const res = await fetch('/api/system/ping', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setView({ kind: 'done', data: (await res.json()) as PingResponse });
    } catch (e) {
      setView({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-hairline bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={disabled || view.kind === 'loading'}
          className="h-[var(--control-height)] rounded-[var(--radius-control)] bg-ink px-3 text-[var(--text-sm)] font-medium text-ink-inverse transition-opacity duration-[var(--duration-state)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {view.kind === 'loading' ? 'Sending…' : 'Send a job to the worker'}
        </button>
        <span className="text-[var(--text-sm)] text-ink-muted">
          {disabled
            ? 'Needs Redis to be reachable.'
            : 'HTTP request → BullMQ job → worker, one trace.'}
        </span>
      </div>

      <div aria-live="polite" className="mt-3 text-[var(--text-sm)]">
        {view.kind === 'error' && (
          <p className="text-[var(--status-critical)]">Request failed: {view.message}</p>
        )}
        {view.kind === 'done' && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-muted">Job</dt>
            <dd className="font-mono">{view.data.jobId ?? '—'}</dd>
            <dt className="text-ink-muted">Worker</dt>
            <dd>
              {view.data.state === 'completed'
                ? 'completed'
                : view.data.state === 'timeout'
                  ? 'no worker answered within 5 s — is `apps/worker` running?'
                  : `failed: ${String(view.data.result)}`}
            </dd>
            <dt className="text-ink-muted">Trace</dt>
            <dd className="font-mono">
              {view.data.traceId ? (
                jaegerBase ? (
                  <a
                    className="text-link underline-offset-2 hover:underline"
                    href={`${jaegerBase}/trace/${view.data.traceId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {view.data.traceId}
                  </a>
                ) : (
                  view.data.traceId
                )
              ) : (
                'no active span — is instrumentation registered?'
              )}
            </dd>
          </dl>
        )}
      </div>
    </div>
  );
}
