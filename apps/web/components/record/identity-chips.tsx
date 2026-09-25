import Link from 'next/link';
import { LocalDateTime } from '@/components/local-time';
import { isoOf } from '@/lib/format';
import { identityLabel, platformName, platformShort } from '@/lib/platforms';

export type IdentityChip = {
  id: string;
  platform: string;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  lastSeenAt: Date | string;
};

/**
 * Channel identity chips on a person's header (§12.2.B): platform code, handle, and the
 * per-platform last touch on hover and in the accessible name. Each chip opens the identity.
 */
export function IdentityChips({ slug, identities }: { slug: string; identities: IdentityChip[] }) {
  if (identities.length === 0) return null;
  return (
    <ul aria-label="Channel identities" className="flex flex-wrap items-center gap-1.5">
      {identities.map((i) => {
        const iso = isoOf(i.lastSeenAt) ?? '';
        return (
          <li key={i.id}>
            <Link
              href={`/w/${slug}/identities/${i.id}`}
              data-testid="identity-chip"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-hairline bg-card px-2 py-0.5 text-[var(--text-xs)] text-ink hover:border-strong focus-visible:shadow-[var(--focus-ring)]"
              aria-label={`${platformName(i.platform)}: ${identityLabel(i)}`}
            >
              <span className="rounded-sm bg-raised px-1 font-mono text-[10px] font-semibold text-ink-secondary">
                {platformShort(i.platform)}
              </span>
              <span className="max-w-[10rem] truncate">{identityLabel(i)}</span>
              <span className="sr-only sm:not-sr-only sm:text-ink-muted">
                · <LocalDateTime iso={iso} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
