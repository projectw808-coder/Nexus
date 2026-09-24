import type { ReactNode } from 'react';

function AlertIcon() {
  return (
    <svg
      aria-hidden
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 6.5v4.5M10 13.5v.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Error state (§0.8, §9.2): the sentence, the remediation, and the way out. Renders in both
 * server and client trees; `error.tsx` boundaries pass `onRetry`.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  remediation,
  reference,
  onRetry,
  retryLabel = 'Try again',
  action,
}: {
  title?: ReactNode;
  message: ReactNode;
  remediation?: ReactNode;
  reference?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-hairline bg-card px-6 py-14 text-center"
      style={{ borderColor: 'var(--status-critical)' }}
    >
      <div className="mb-3 text-critical">
        <AlertIcon />
      </div>
      <h2 className="text-[var(--text-md)] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-md text-[var(--text-sm)] text-ink-secondary">{message}</p>
      {remediation ? (
        <p className="mt-1 max-w-md text-[var(--text-sm)] text-ink-muted">{remediation}</p>
      ) : null}
      {reference ? (
        <p className="mt-3 font-mono text-[var(--text-xs)] text-ink-muted">ref {reference}</p>
      ) : null}
      {onRetry || action ? (
        <div className="mt-5 flex items-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-[var(--control-height)] items-center rounded-[var(--radius-control)] bg-ink px-3 text-[var(--text-sm)] font-medium text-ink-inverse"
            >
              {retryLabel}
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** Inline result of a form action: a sentence with the right tone and an icon, never colour alone. */
export function InlineNotice({
  tone,
  children,
  id,
}: {
  tone: 'good' | 'critical' | 'warning' | 'neutral';
  children: ReactNode;
  id?: string;
}) {
  const color =
    tone === 'good'
      ? 'text-good'
      : tone === 'critical'
        ? 'text-critical'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-ink-secondary';
  const glyph = tone === 'good' ? '✓' : tone === 'critical' ? '!' : tone === 'warning' ? '△' : '·';
  return (
    <p
      id={id}
      role={tone === 'critical' ? 'alert' : 'status'}
      className={`flex items-start gap-2 text-[var(--text-sm)] ${color}`}
    >
      <span aria-hidden className="w-3 shrink-0 text-center font-semibold">
        {glyph}
      </span>
      <span className="text-ink-secondary">{children}</span>
    </p>
  );
}
