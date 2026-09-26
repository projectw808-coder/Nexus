/**
 * §12.4's colour rules, mechanically. Each `it` here maps to one bullet of the spec, so a
 * regression names the rule it broke rather than "a snapshot changed".
 */
import { describe, expect, it } from 'vitest';
import {
  CHART_PALETTE,
  OTHER_SERIES_KEY,
  OTHER_SLOT,
  createSeriesPalette,
  divergingColor,
  foldSeriesKeys,
  funnelRamp,
  hashSeriesKey,
  mixHex,
  relativeLuminance,
  sequentialColor,
  sequentialRamp,
  textureForSlot,
} from './chart-palette.ts';
import { DIVERGING, MAX_SERIES, SEQUENTIAL, SERIES } from './tokens.ts';

describe('categorical palette (§12.4 bullet 1)', () => {
  it('is the exact fixed array, in order, in both modes', () => {
    expect(SERIES.light).toEqual([
      '#2a78d6',
      '#eb6834',
      '#1baf7a',
      '#eda100',
      '#e87ba4',
      '#008300',
      '#4a3aa7',
      '#e34948',
    ]);
    expect(SERIES.dark).toEqual([
      '#3987e5',
      '#d95926',
      '#199e70',
      '#c98500',
      '#d55181',
      '#008300',
      '#9085e9',
      '#e66767',
    ]);
    expect(CHART_PALETTE.maxSeries).toBe(8);
  });

  it('hands out slots in declaration order, not alphabetically or by hash', () => {
    const p = createSeriesPalette(['youtube', 'instagram', 'x']);
    expect(p.colorForSeries('youtube').slot).toBe(0);
    expect(p.colorForSeries('instagram').slot).toBe(1);
    expect(p.colorForSeries('x').slot).toBe(2);
    expect(p.colorForSeries('youtube').light).toBe(SERIES.light[0]);
    expect(p.colorForSeries('youtube').dark).toBe(SERIES.dark[0]);
  });

  it('never cycles: a 9th distinct series folds to "Other", never a generated hue', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const fold = foldSeriesKeys(keys);
    expect(fold.didFold).toBe(true);
    expect(fold.keys).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', OTHER_SERIES_KEY]);
    expect(fold.keys).toHaveLength(MAX_SERIES);
    expect(fold.folded).toEqual(['h', 'i', 'j']);

    const p = createSeriesPalette(keys);
    const other = p.colorForSeries(OTHER_SERIES_KEY);
    expect(other.slot).toBe(OTHER_SLOT);
    for (const tail of ['h', 'i', 'j']) {
      expect(p.bucketFor(tail)).toBe(OTHER_SERIES_KEY);
      expect(p.colorForSeries(tail)).toEqual(other);
    }
    // Every colour handed out is a literal from the fixed array — nothing generated.
    const all = new Set<string>([...SERIES.light, ...SERIES.dark]);
    for (const k of keys) {
      expect(all.has(p.colorForSeries(k).light)).toBe(true);
      expect(all.has(p.colorForSeries(k).dark)).toBe(true);
    }
  });

  it('fits exactly eight series without folding', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const fold = foldSeriesKeys(keys);
    expect(fold.didFold).toBe(false);
    const p = createSeriesPalette(keys);
    expect(keys.map((k) => p.colorForSeries(k).slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('colour follows the entity, never its rank (§12.4 bullet 3)', () => {
  it('hiding a series and showing it again does not repaint the survivors', () => {
    const all = ['instagram', 'x', 'linkedin', 'youtube'];
    const p = createSeriesPalette(all);
    const before = all.map((k) => p.colorForSeries(k).light);

    // Render with the first series filtered out, then filtered back in. A rank-bound chart
    // would now give `x` slot 0; a key-bound one cannot.
    const visible = all.filter((k) => k !== 'instagram');
    const during = visible.map((k) => p.colorForSeries(k).light);
    const after = all.map((k) => p.colorForSeries(k).light);

    expect(during).toEqual(before.slice(1));
    expect(after).toEqual(before);
    expect(p.colorForSeries('x').slot).toBe(1);
  });

  it('two palettes over the same declared set agree, so two charts agree', () => {
    const keys = ['support', 'sales', 'complaint'];
    const a = createSeriesPalette(keys);
    const b = createSeriesPalette(keys);
    for (const k of keys) expect(a.colorForSeries(k)).toEqual(b.colorForSeries(k));
  });

  it('an undeclared key gets a content-derived slot, not an arrival-order one', () => {
    // 'support' and 'complaint' hash to different preferred slots, so neither probes past the
    // other and arrival order cannot matter. (Colliding keys probe deterministically instead —
    // covered by the "never hands the same slot to two live keys" case below.)
    const first = createSeriesPalette();
    const second = createSeriesPalette();
    first.colorForSeries('complaint');
    first.colorForSeries('support');
    second.colorForSeries('support');
    second.colorForSeries('complaint');
    expect(first.colorForSeries('support').slot).toBe(second.colorForSeries('support').slot);
    expect(first.colorForSeries('complaint').slot).toBe(second.colorForSeries('complaint').slot);
    // The slot is the key's own hash, not 0 and 1 in arrival order.
    expect(first.colorForSeries('support').slot).toBe(hashSeriesKey('support') % MAX_SERIES);
    expect(first.colorForSeries('complaint').slot).toBe(hashSeriesKey('complaint') % MAX_SERIES);
    expect(hashSeriesKey('alpha')).toBe(hashSeriesKey('alpha'));
    expect(hashSeriesKey('alpha')).not.toBe(hashSeriesKey('zulu'));
  });

  it('never hands the same slot to two live keys', () => {
    const p = createSeriesPalette();
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const slots = keys.map((k) => p.colorForSeries(k).slot);
    expect(new Set(slots).size).toBe(keys.length);
  });

  it('memoises: repeated lookups are the same object identity', () => {
    const p = createSeriesPalette(['a', 'b']);
    expect(p.colorForSeries('a')).toBe(p.colorForSeries('a'));
  });
});

describe('sequential and diverging scales (§12.4 bullet 5)', () => {
  it('sequential interpolates through exactly the two named stops', () => {
    expect(SEQUENTIAL.start).toBe('#cde2fb');
    expect(SEQUENTIAL.end).toBe('#0d366b');
    expect(sequentialColor(0)).toBe('#cde2fb');
    expect(sequentialColor(1)).toBe('#0d366b');
    const ramp = sequentialRamp(5);
    expect(ramp[0]).toBe('#cde2fb');
    expect(ramp[4]).toBe('#0d366b');
    // One hue, light→dark: strictly monotonic luminance, no rainbow detour.
    const lum = ramp.map(relativeLuminance);
    for (let i = 1; i < lum.length; i++) expect(lum[i]!).toBeLessThan(lum[i - 1]!);
    // And it is a pure two-stop mix, not a library gradient with extra control points.
    expect(sequentialColor(0.5)).toBe(mixHex('#cde2fb', '#0d366b', 0.5));
  });

  it('diverging is blue↔red with a neutral gray midpoint, never a hue at the middle', () => {
    expect(divergingColor(0, 'light')).toBe('#f0efec');
    expect(divergingColor(0, 'dark')).toBe('#383835');
    expect(divergingColor(-1, 'light')).toBe(DIVERGING.light.low);
    expect(divergingColor(1, 'light')).toBe(DIVERGING.light.high);
    expect(divergingColor(-1, 'dark')).toBe(DIVERGING.dark.low);
    expect(divergingColor(1, 'dark')).toBe(DIVERGING.dark.high);
    // The midpoint is gray in the literal sense: all three channels within one step.
    for (const mode of ['light', 'dark'] as const) {
      const mid = divergingColor(0, mode).slice(1);
      const [r, g, b] = [mid.slice(0, 2), mid.slice(2, 4), mid.slice(4, 6)].map((h) =>
        parseInt(h, 16),
      ) as [number, number, number];
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(6);
    }
    // Each half is a straight mix from the midpoint — no third hue can appear.
    expect(divergingColor(0.5, 'light')).toBe(mixHex('#f0efec', DIVERGING.light.high, 0.5));
    expect(divergingColor(-0.5, 'light')).toBe(mixHex('#f0efec', DIVERGING.light.low, 0.5));
  });

  it('clamps instead of extrapolating past the stops', () => {
    expect(sequentialColor(-2)).toBe('#cde2fb');
    expect(sequentialColor(9)).toBe('#0d366b');
    expect(divergingColor(-9, 'light')).toBe(DIVERGING.light.low);
  });
});

describe('funnel ordinal ramp (§12.4 dashboard defaults)', () => {
  it('light never starts lighter than #86b6ef', () => {
    const bound = relativeLuminance('#86b6ef');
    const ramp = funnelRamp(6, 'light');
    expect(ramp[0]).toBe('#86b6ef');
    for (const step of ramp) expect(relativeLuminance(step)).toBeLessThanOrEqual(bound + 1e-9);
  });

  it('dark never starts darker than #184f95', () => {
    const bound = relativeLuminance('#184f95');
    const ramp = funnelRamp(6, 'dark');
    expect(ramp[0]).toBe('#184f95');
    for (const step of ramp) expect(relativeLuminance(step)).toBeGreaterThanOrEqual(bound - 1e-9);
  });

  it('is ordinal and monotonic in both modes, and single-hue (no rainbow)', () => {
    const light = funnelRamp(5, 'light').map(relativeLuminance);
    for (let i = 1; i < light.length; i++) expect(light[i]!).toBeLessThan(light[i - 1]!);
    const dark = funnelRamp(5, 'dark').map(relativeLuminance);
    for (let i = 1; i < dark.length; i++) expect(dark[i]!).toBeGreaterThan(dark[i - 1]!);
    expect(funnelRamp(1, 'light')).toEqual(['#86b6ef']);
    expect(funnelRamp(0, 'light')).toEqual([]);
  });

  it('is never a categorical series colour by accident', () => {
    const series = new Set<string>([...SERIES.light, ...SERIES.dark]);
    for (const mode of ['light', 'dark'] as const) {
      for (const step of funnelRamp(7, mode)) expect(series.has(step)).toBe(false);
    }
  });
});

describe('texture fills (§12.4 accessibility)', () => {
  it('uses only the two named angles and separates all eight slots', () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < MAX_SERIES; slot++) {
      const t = textureForSlot(slot);
      expect([45, 135]).toContain(t.angle);
      seen.add(`${t.angle}/${t.gap}/${t.width}`);
    }
    expect(seen.size).toBe(MAX_SERIES);
  });
});
