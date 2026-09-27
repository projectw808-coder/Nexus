import { LinkButton } from '@/components/button';
import { PlatformIcon } from '@/lib/platform-icons';
import { platformDescription, platformName } from '@/lib/platforms';

export function ConnectPlatformCard({ platform, url }: { platform: string; url: string | null }) {
  return (
    <li className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="shrink-0">{PlatformIcon[platform]}</span>
        <span className="text-[var(--text-sm)] font-medium text-ink">{platformName(platform)}</span>
      </div>
      <p className="text-[var(--text-xs)] text-ink-muted">{platformDescription(platform)}</p>
      {url ? (
        <LinkButton
          href={url}
          variant="secondary"
          size="sm"
          prefetch={false}
          className="self-start"
        >
          Connect
        </LinkButton>
      ) : (
        <span className="text-[var(--text-xs)] text-ink-muted">Not configured on this server</span>
      )}
    </li>
  );
}
