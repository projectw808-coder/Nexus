/**
 * "Why are these the same person?" (§10): the verbatim signals behind a link or a suggestion,
 * one line each with its tier, its weight and the values on both sides. Explainability is the
 * feature — every automatic decision can be read back here.
 */
export type WhySignal = {
  kind: string;
  tier: number;
  weight: number;
  label: string;
  left: unknown;
  right: unknown;
};

export function WhyPanel({
  score,
  signals,
  note,
  compact,
}: {
  score: number;
  signals: WhySignal[];
  note?: string | null;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--radius-card)] border border-hairline bg-raised ${compact ? 'p-2' : 'p-3'} text-[var(--text-xs)]`}
      data-testid="why-panel"
    >
      <p className="mb-1 font-medium text-ink">
        Why are these the same person?{' '}
        <span className="tnum font-normal text-ink-muted">
          confidence {Math.round(score * 100)}%
        </span>
      </p>
      {note ? <p className="mb-1 text-ink-secondary">{note}</p> : null}
      {signals.length === 0 ? (
        <p className="text-ink-muted">
          {note ? 'No computed signals.' : 'No signals were recorded for this decision.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {signals.map((s, i) => (
            <li key={`${s.kind}:${i}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="rounded-sm border border-hairline px-1 font-mono text-[10px] text-ink-secondary">
                tier {s.tier}
              </span>
              <span className="text-ink">{s.label}</span>
              <span className="tnum text-ink-muted">+{Math.round(s.weight * 100)}%</span>
              {!compact ? (
                <span className="basis-full font-mono text-[10px] text-ink-muted">
                  {show(s.left)} ↔ {show(s.right)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v && 'handle' in v && 'platform' in v)
    return `@${String((v as { handle: string }).handle)} (${String((v as { platform: string }).platform)})`;
  if (typeof v === 'object' && v && 'externalId' in v)
    return `${String((v as { platform?: string }).platform ?? '')}:${String((v as { externalId: string }).externalId)}`;
  return JSON.stringify(v);
}

/** Read a link's or suggestion's evidence blob into the shape the panel renders. */
export function evidenceOf(value: unknown): {
  score: number;
  signals: WhySignal[];
  note: string | null;
} {
  const v = (typeof value === 'object' && value !== null ? value : {}) as {
    score?: unknown;
    signals?: unknown;
    note?: unknown;
  };
  return {
    score: typeof v.score === 'number' ? v.score : 0,
    signals: Array.isArray(v.signals) ? (v.signals as WhySignal[]) : [],
    note: typeof v.note === 'string' ? v.note : null,
  };
}
