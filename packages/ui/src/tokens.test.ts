import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIVERGING, MAX_SERIES, SEQUENTIAL, SERIES, seriesColorMap, STATUS } from './tokens.ts';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('design tokens', () => {
  it('ships exactly eight categorical series in both modes', () => {
    expect(SERIES.light).toHaveLength(MAX_SERIES);
    expect(SERIES.dark).toHaveLength(MAX_SERIES);
    for (let i = 1; i <= MAX_SERIES; i++) {
      expect(css).toMatch(new RegExp(`--series-${i}: ${SERIES.light[i - 1]};`));
      expect(css).toMatch(new RegExp(`--series-${i}: ${SERIES.dark[i - 1]};`));
    }
  });

  it('status colours are never reused as series colours', () => {
    const all = new Set([...SERIES.light, ...SERIES.dark]);
    for (const s of Object.values(STATUS)) expect(all.has(s)).toBe(false);
  });

  it('sequential ramp and diverging midpoints match the spec', () => {
    expect(css).toContain(`--seq-start: ${SEQUENTIAL.start};`);
    expect(css).toContain(`--seq-end: ${SEQUENTIAL.end};`);
    expect(css).toContain(`--div-mid: ${DIVERGING.light.mid};`);
    expect(css).toContain(`--div-mid: ${DIVERGING.dark.mid};`);
  });

  it('defines dark tokens both for the OS preference and the explicit toggle', () => {
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\)/,
    );
    expect(css).toMatch(/:root\[data-theme='dark'\]/);
  });

  it('binds colour to the entity key and refuses a ninth series', () => {
    const m = seriesColorMap(['x', 'instagram', 'youtube'], 'light');
    expect(m.instagram).toBe(SERIES.light[1]);
    expect(() => seriesColorMap(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'light')).toThrow(
      RangeError,
    );
  });
});
