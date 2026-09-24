import type { Role } from '@nexus/db';
import { ROLE_LABEL } from '@/lib/roles';

/** Role as a quiet pill. Owners get a filled pill so the one who can delete stands out. */
export function RoleBadge({ role, className = '' }: { role: Role; className?: string }) {
  const filled = role === 'OWNER';
  return (
    <span
      className={[
        'inline-flex h-5 items-center rounded-[var(--radius-pill)] px-2 text-[var(--text-xs)] font-medium leading-none',
        filled ? 'bg-ink text-ink-inverse' : 'border border-hairline text-ink-secondary',
        className,
      ].join(' ')}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}
