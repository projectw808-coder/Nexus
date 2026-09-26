/**
 * A compact 7-day bar sparkline (§12.2.C connection card). Decorative — the count it summarizes
 * is always shown as text beside it, so the chart never carries information alone (§12.3).
 */
export function Sparkline({
  values,
  width = 84,
  height = 24,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const max = Math.max(1, ...values);
  const barWidth = width / values.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Last ${values.length} days: ${values.join(', ')}`}
      className="shrink-0"
    >
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * height);
        return (
          <rect
            key={i}
            x={i * barWidth + 1}
            y={height - h}
            width={Math.max(1, barWidth - 2)}
            height={h}
            rx={1}
            className={v > 0 ? 'fill-ink-secondary' : 'fill-[var(--border-hairline)]'}
          />
        );
      })}
    </svg>
  );
}
