import type { ReactNode } from 'react';

/**
 * Designed empty state (§0.8): a title, one sentence of context and, when there is one, the
 * action that fills the screen. Quiet by construction — dashed hairline, no illustration.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  compact,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={[
        'flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-hairline bg-card text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
      ].join(' ')}
    >
      {icon ? <div className="mb-3 text-ink-muted">{icon}</div> : null}
      <h2 className="text-[var(--text-md)] font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-md text-[var(--text-sm)] text-ink-secondary">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
