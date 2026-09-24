/**
 * Token values as TypeScript, for code that cannot read CSS variables: chart libraries that
 * need literal colours per series, the a11y texture-fill fallback, exports, and tests that
 * enforce the §12.4 rules. Keep in sync with tokens.css (the test checks the series count and
 * ramp endpoints).
 */

export type Mode = 'light' | 'dark';

/** Categorical series, fixed order, never cycled. Index 0 is series 1. */
export const SERIES: Record<
  Mode,
  readonly [string, string, string, string, string, string, string, string]
> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const MAX_SERIES = 8;
/** Scatter / bubble / choropleth / small multiples cap (§12.4). */
export const MAX_SERIES_POSITIONAL = 3;

export const SEQUENTIAL = {
  start: '#cde2fb',
  end: '#0d366b',
  funnelStart: { light: '#86b6ef', dark: '#184f95' },
} as const;

export const DIVERGING: Record<Mode, { low: string; mid: string; high: string }> = {
  light: { low: '#2a78d6', mid: '#f0efec', high: '#e34948' },
  dark: { low: '#3987e5', mid: '#383835', high: '#e66767' },
};

export const CHART_CHROME: Record<Mode, { grid: string; baseline: string; label: string }> = {
  light: { grid: '#e1e0d9', baseline: '#c3c2b7', label: '#6f6e69' },
  dark: { grid: '#2c2c2a', baseline: '#383835', label: '#9c9a93' },
};

/** Never a data-series colour. Always paired with an icon + label. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;
export type StatusTone = keyof typeof STATUS;

/** Brand hues, allowed ONLY on platform chips, connector cards and source badges. */
export const PLATFORM_ACCENT = {
  FACEBOOK: '#1877f2',
  INSTAGRAM: '#e1306c',
  X: { light: '#0b0b0b', dark: '#ffffff' },
  LINKEDIN: '#0a66c2',
  TIKTOK: '#fe2c55',
  YOUTUBE: '#ff0000',
  GMAIL: '#ea4335',
  GOOGLE_CALENDAR: '#4285f4',
  GOOGLE_BUSINESS: '#34a853',
  KEITARO: '#f0821e',
  MOCK: '#898781',
} as const;

export function platformAccent(platform: keyof typeof PLATFORM_ACCENT, mode: Mode): string {
  const v = PLATFORM_ACCENT[platform];
  return typeof v === 'string' ? v : v[mode];
}

/** 45° / 135° hatch textures for forced-colors, print and the accessibility setting. */
export const TEXTURES = ['none', 'hatch-45', 'hatch-135', 'dots', 'cross'] as const;

export const TYPE_SCALE = [12, 13, 14, 16, 20, 24, 32] as const;
export const SPACE = [4, 8, 12, 16, 24, 32] as const;
export const RADIUS = { control: 6, card: 10 } as const;
export const MOTION = { state: 120, layout: 200, ease: 'cubic-bezier(.2,0,0,1)' } as const;

/**
 * Assign a stable series colour by entity key, never by rank (§12.4 "colour follows the
 * entity"). Callers pass the full ordered set of keys once; filtering later does not repaint.
 */
export function seriesColorMap<K extends string>(
  keys: readonly K[],
  mode: Mode,
): Record<K, string> {
  if (keys.length > MAX_SERIES) {
    throw new RangeError(
      `${keys.length} series exceeds the ${MAX_SERIES}-series cap; fold to "Other" or facet.`,
    );
  }
  const out = {} as Record<K, string>;
  keys.forEach((k, i) => {
    out[k] = SERIES[mode][i] as string;
  });
  return out;
}
