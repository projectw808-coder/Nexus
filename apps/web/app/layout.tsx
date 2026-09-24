import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, themeInitScript, type Theme } from '@nexus/ui';
import { ThemeToggle } from '@/components/theme-toggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nexus',
  description: 'Multi-channel, API-native CRM with per-platform control.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The cookie lets the server emit the right attribute so there is no flash on first paint,
  // even before the inline script runs or when JavaScript is disabled.
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';
  const htmlProps = theme === 'system' ? {} : { 'data-theme': theme };

  return (
    <html lang="en" suppressHydrationWarning {...htmlProps}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-card focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <header className="flex h-12 items-center justify-between border-b border-hairline px-4">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block size-5 rounded-[6px] bg-ink"
              style={{ maskImage: 'none' }}
            />
            <span className="text-[var(--text-md)] font-semibold tracking-tight">Nexus</span>
            <span className="rounded-[var(--radius-pill)] border border-hairline px-2 text-[var(--text-xs)] text-ink-muted">
              Phase 0
            </span>
          </div>
          <ThemeToggle initial={theme} />
        </header>
        <main id="main" className="mx-auto w-full max-w-5xl px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
