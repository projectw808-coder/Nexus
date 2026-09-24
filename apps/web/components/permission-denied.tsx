import type { ReactNode } from 'react';
import type { Role } from '@nexus/db';
import { ROLE_LABEL } from '@/lib/roles';

function LockIcon() {
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
      <rect x="4" y="9" width="12" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </svg>
  );
}

/**
 * Permission-denied state (§0.8). Explains what the screen is, why it is closed and who can
 * open it, instead of a bare 403. Never colour alone: lock icon + text carry the meaning.
 */
export function PermissionDenied({
  title = 'You do not have access to this',
  description,
  currentRole,
  requiredRole,
  action,
}: {
  title?: ReactNode;
  description?: ReactNode;
  currentRole?: Role;
  requiredRole?: Role;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-hairline bg-card px-6 py-14 text-center"
    >
      <div className="mb-3 text-ink-muted">
        <LockIcon />
      </div>
      <h2 className="text-[var(--text-md)] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 max-w-md text-[var(--text-sm)] text-ink-secondary">
        {description ?? 'Ask a workspace owner or admin if you need this.'}
      </p>
      {currentRole || requiredRole ? (
        <dl className="mt-4 grid grid-cols-[max-content_max-content] gap-x-4 gap-y-1 text-[var(--text-sm)]">
          {currentRole ? (
            <>
              <dt className="text-ink-muted">Your role</dt>
              <dd className="text-left">{ROLE_LABEL[currentRole]}</dd>
            </>
          ) : null}
          {requiredRole ? (
            <>
              <dt className="text-ink-muted">Needs</dt>
              <dd className="text-left">{ROLE_LABEL[requiredRole]} or above</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** A one-line note used above read-only tables. */
export function PermissionNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-[var(--radius-control)] border border-hairline bg-card px-3 py-2 text-[var(--text-sm)] text-ink-secondary">
      <span className="text-ink-muted">
        <LockIcon />
      </span>
      <span>{children}</span>
    </p>
  );
}
