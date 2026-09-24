import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  as: Heading = 'h1',
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  as?: 'h1' | 'h2';
}) {
  const size = Heading === 'h1' ? 'text-[var(--text-xl)]' : 'text-[var(--text-lg)]';
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
            {eyebrow}
          </p>
        ) : null}
        <Heading className={`${size} font-semibold tracking-tight`}>{title}</Heading>
        {description ? <p className="mt-1 max-w-prose text-ink-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
