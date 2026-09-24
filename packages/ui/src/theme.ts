/**
 * Theme switching. Tokens live in tokens.css; this module only decides which `data-theme`
 * value the <html> element carries. Order of precedence (§12.3): explicit toggle beats the OS.
 *
 *  - "system": no data-theme attribute → tokens follow prefers-color-scheme.
 *  - "light" | "dark": data-theme set → the explicit block wins both ways.
 *
 * Persistence is two-fold: localStorage (fast path, read by `themeInitScript` before first
 * paint) and a cookie (read by the server so SSR emits the right attribute and there is no
 * flash even with JavaScript disabled).
 */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'nexus.theme';
export const THEME_COOKIE = 'nexus-theme';
export const THEME_ATTRIBUTE = 'data-theme';

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Inline, dependency-free script for <head>. Applies the stored theme before first paint. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='light'||t==='dark'){document.documentElement.setAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)},t);}else if(t==='system'){document.documentElement.removeAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)});}}catch(e){}})();`;

/** Client only. Sets the attribute and persists to localStorage + cookie (1 year). */
export function applyTheme(theme: Theme, doc: Document = document): void {
  const root = doc.documentElement;
  if (theme === 'system') root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, theme);
  try {
    doc.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* private mode / blocked storage: cookie still persists */
  }
  doc.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Client only. What the user chose, defaulting to "system". */
export function readStoredTheme(doc: Document = document): Theme {
  try {
    const v = doc.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(v)) return v;
  } catch {
    /* fall through to cookie */
  }
  const m = doc.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=(light|dark|system)`));
  return m && isTheme(m[1]) ? m[1] : 'system';
}

/** Resolve "system" to what is actually rendered. Client only. */
export function resolvedTheme(theme: Theme, win: Window = window): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
