import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'good' | 'warning' | 'critical' | 'info';

const TONE: Record<PillTone, { className: string; glyph: string }> = {
  neutral: { className: 'border border-hairline text-ink-secondary', glyph: '·' },
  good: { className: 'bg-[var(--status-good-bg)] text-good', glyph: '✓' },
  warning: { className: 'bg-[var(--status-warning-bg)] text-warning', glyph: '△' },
  critical: { className: 'bg-[var(--status-critical-bg)] text-critical', glyph: '!' },
  info: { className: 'bg-raised border border-hairline text-ink', glyph: '…' },
};

/**
 * A quiet status pill. Tone is carried by a glyph and the label, never colour alone (§12.3).
 * Pass `glyph={null}` to drop the glyph when the label already says it.
 */
export function StatusPill({
  tone,
  children,
  glyph,
  title,
}: {
  tone: PillTone;
  children: ReactNode;
  glyph?: string | null;
  title?: string;
}) {
  const t = TONE[tone];
  const g = glyph === undefined ? t.glyph : glyph;
  return (
    <span
      title={title}
      className={`inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[var(--radius-pill)] px-2 text-[var(--text-xs)] font-medium leading-none ${t.className}`}
    >
      {g ? (
        <span aria-hidden className="font-semibold">
          {g}
        </span>
      ) : null}
      <span className="text-ink-secondary">{children}</span>
    </span>
  );
}
