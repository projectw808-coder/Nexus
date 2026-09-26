/**
 * §12.4's "Marks" bullet and the stacking gap, mechanically. The React layer consumes these
 * numbers rather than hard-coding its own, so policing them here polices every chart.
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_MARKS,
  areaPath,
  bandScale,
  barPath,
  formatCompact,
  hatchPath,
  linePath,
  linearScale,
  niceDomain,
  niceTicks,
  stackCategory,
} from './chart-geometry.ts';

describe('mark constants (§12.4 "Marks")', () => {
  it('are exactly the sizes the spec fixes', () => {
    expect(CHART_MARKS.lineWidth).toBe(2);
    expect(CHART_MARKS.markerSize).toBeGreaterThanOrEqual(8);
    expect(CHART_MARKS.dataEndRadius).toBe(4);
    expect(CHART_MARKS.surfaceGap).toBe(2);
    expect(CHART_MARKS.surfaceRing).toBe(2);
  });
});

describe('barPath: 4px rounded data-ends anchored to the baseline', () => {
  it('rounds the data end and leaves the baseline end square', () => {
    const d = barPath(10, 20, 24, 60);
    // Two arcs at the top, and the closing edge runs straight along the baseline.
    expect(d.match(/a4 4/g)).toHaveLength(2);
    expect(d).toContain('v56'); // 60 − radius, i.e. the straight drop to the baseline
    expect(d.endsWith('Z')).toBe(true);
  });

  it('degrades to a rectangle rather than a lozenge on a short or thin bar', () => {
    expect(barPath(0, 0, 24, 0)).toBe('M0 0h24v0h-24Z');
    const thin = barPath(0, 0, 3, 40);
    expect(thin).toContain('a1.5 1.5');
  });

  it('draws a plain rect for the middle of a stack', () => {
    expect(barPath(5, 5, 10, 10, 4, false)).toBe('M5 5h10v10h-10Z');
  });
});

describe('stackCategory', () => {
  it('stacks in the declared series order and gives the data-end to the top non-zero segment', () => {
    const { segments, total } = stackCategory(['a', 'b', 'c'], (k) =>
      k === 'a' ? 3 : k === 'b' ? 0 : 5,
    );
    expect(total).toBe(8);
    expect(segments.map((s) => [s.from, s.to])).toEqual([
      [0, 3],
      [3, 3],
      [3, 8],
    ]);
    expect(segments.filter((s) => s.isTop).map((s) => s.seriesKey)).toEqual(['c']);
  });

  it('keeps zero-valued series as segments so a tooltip can still say 0', () => {
    const { segments } = stackCategory(['a', 'b'], () => 0);
    expect(segments).toHaveLength(2);
    expect(segments.some((s) => s.isTop)).toBe(false);
  });
});

describe('scales and ticks', () => {
  it('maps the domain onto the range linearly, inverted for SVG y', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(50)).toBe(100);
  });

  it('does not divide by zero on a flat domain', () => {
    const y = linearScale([5, 5], [100, 0]);
    expect(Number.isFinite(y(5))).toBe(true);
  });

  it('picks human ticks that always include the baseline', () => {
    expect(niceTicks(0, 10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0, 0, 4)[0]).toBe(0);
    expect(niceDomain([0, 3, 7])[0]).toBe(0);
    expect(niceDomain([0, 3, 7])[1]).toBeGreaterThanOrEqual(7);
  });

  it('keeps a negative domain (sentiment goes to −1) around zero', () => {
    const [lo, hi] = niceDomain([-1, 0.5]);
    expect(lo).toBeLessThanOrEqual(-1);
    expect(hi).toBeGreaterThanOrEqual(0.5);
    expect(niceTicks(-1, 1, 4)).toContain(0);
  });

  it('bands leave room between adjacent fills', () => {
    const b = bandScale(4, [0, 400], 0.2);
    expect(b.step).toBe(100);
    expect(b.width).toBe(80);
    expect(b.center(0)).toBe(50);
    expect(b.start(0)).toBe(10);
  });
});

describe('path builders', () => {
  it('draws a polyline with no smoothing (a spline would invent values)', () => {
    expect(
      linePath([
        { x: 0, y: 10 },
        { x: 5, y: 2 },
      ]),
    ).toBe('M0 10 L5 2');
    expect(linePath([])).toBe('');
    expect(linePath([{ x: 1, y: 1 }])).not.toContain('C');
  });

  it('closes an area down to the baseline', () => {
    const d = areaPath(
      [
        { x: 0, y: 10 },
        { x: 5, y: 2 },
      ],
      40,
    );
    expect(d).toContain('L5 40');
    expect(d).toContain('L0 40');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('hatches only at 45° or 135°', () => {
    expect(hatchPath(45, 6)).toContain('M0 6 L6 0');
    expect(hatchPath(135, 6)).toContain('M0 0 L6 6');
  });
});

describe('formatCompact', () => {
  it('is locale-independent', () => {
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(1500)).toBe('1.5k');
    expect(formatCompact(2_000_000)).toBe('2M');
    expect(formatCompact(0)).toBe('0');
  });
});
