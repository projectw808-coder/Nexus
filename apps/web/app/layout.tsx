import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { isTheme, THEME_COOKIE, themeInitScript, type Theme } from '@nexus/ui';
import { ThemeToggle } from '@/components/theme-toggle';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Pantera CRM',
  description: 'Multi-channel, API-native CRM with per-platform control.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The cookie lets the server emit the right attribute so there is no flash on first paint,
  // even before the inline script runs or when JavaScript is disabled.
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';
  const htmlProps = theme === 'system' ? {} : { 'data-theme': theme };

  return (
    <html lang="en" suppressHydrationWarning {...htmlProps} className={inter.variable}>
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
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" className="text-link">
              <path
                d="M12 3.5 20 8v8l-8 4.5L4 16V8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="2.4" fill="currentColor" />
            </svg>
            <span className="text-[var(--text-md)] font-bold tracking-tight">Pantera CRM</span>
          </div>
          <ThemeToggle initial={theme} />
        </header>
        {/* Workspace screens (the inbox, tables, boards) use the full width; app/(site) re-adds the measure. */}
        <main id="main" className="mx-auto w-full px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
