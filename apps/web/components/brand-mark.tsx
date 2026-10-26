/** The orange "P" tile + wordmark. The tile is a logotype (aria-hidden), so white-on-orange is
 * exempt from the text-contrast rule; the wordmark beside it carries the name. */
export function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const tile =
    size === 'md' ? 'size-8 text-[21px] rounded-[7px]' : 'size-6 text-[13px] rounded-[6px]';
  return (
    <span className="flex items-center gap-3 whitespace-nowrap">
      <span
        aria-hidden
        className={`${tile} grid shrink-0 place-items-center bg-[linear-gradient(140deg,#ff9a38,#f25a06)] font-extrabold leading-none text-white`}
      >
        P
      </span>
      <span
        className={
          size === 'md'
            ? 'text-[17px] font-bold tracking-tight'
            : 'text-[var(--text-md)] font-bold tracking-tight'
        }
      >
        Pantera CRM
      </span>
    </span>
  );
}
