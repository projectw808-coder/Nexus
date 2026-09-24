/**
 * Fractional indexing over float positions (ListEntry.position). Inserting between neighbours
 * takes the midpoint; when doubles run out of precision the caller rebalances the list.
 */
export const POSITION_STEP = 1024;
/** Below this gap the midpoint may collide; rebalance. */
export const MIN_GAP = 1e-6;

export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  if (before === null) return (after as number) - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;
  return before + (after - before) / 2;
}

export function needsRebalance(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  return after - before < MIN_GAP;
}

/** Evenly spaced positions for `count` items, for a rebalance. */
export function rebalancedPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}
