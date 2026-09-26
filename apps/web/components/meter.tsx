/**
 * A rate-budget gauge (§12.2.C connection card / health console): a horizontal fill bar whose
 * colour is always paired with the percentage in text, never colour alone (§12.3).
 */
export function Meter({
  used,
  limit,
  label,
}: {
  used: number;
  limit: number;
  /** e.g. "4,800 calls/hour" — shown under the bar. */
  label: string;
}) {
  const pct = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
  const percent = Math.round(pct * 100);
  const fillClass = pct >= 1 ? 'bg-critical' : pct >= 0.8 ? 'bg-warning' : 'bg-good';
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
      >
        <div className={`h-full rounded-full ${fillClass}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[var(--text-xs)] text-ink-muted">
        {percent}% of {label}
      </p>
    </div>
  );
}
