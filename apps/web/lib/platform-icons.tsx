import type { ReactNode } from 'react';

/**
 * Simple brand-colored glyphs for the integrations "Add a connection" gallery. These are
 * original geometric renderings (not traced brand artwork), keyed by the same `Platform`
 * strings as `PLATFORM_NAME` in `./platforms`.
 */
export const PlatformIcon: Record<string, ReactNode> = {
  FACEBOOK: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#1877F2" />
      <path
        d="M16.6 15.2h2.2l.4-2.7h-2.6v-1.6c0-.9.3-1.6 1.7-1.6h1.1V6.9c-.6-.1-1.4-.2-2.3-.2-2.3 0-3.9 1.4-3.9 3.9v2h-2.4v2.7h2.4v6.6h2.4v-6.7z"
        fill="#fff"
      />
    </svg>
  ),
  INSTAGRAM: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <defs>
        <linearGradient id="ig-grad" x1="0" y1="28" x2="28" y2="0">
          <stop offset="0" stopColor="#FFDD55" />
          <stop offset="0.5" stopColor="#E1306C" />
          <stop offset="1" stopColor="#5B51D8" />
        </linearGradient>
      </defs>
      <rect width="28" height="28" rx="7" fill="url(#ig-grad)" />
      <rect x="8" y="8" width="12" height="12" rx="4" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="14" cy="14" r="3.2" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="18.4" cy="9.6" r="1" fill="#fff" />
    </svg>
  ),
  X: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#000" />
      <path
        d="M8 8l5 6.2L8 20h1.7l4.2-4.9L17.4 20H20l-5.3-6.6L20 8h-1.7l-3.9 4.5L11 8H8z"
        fill="#fff"
      />
    </svg>
  ),
  LINKEDIN: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#0A66C2" />
      <rect x="7" y="11" width="3" height="10" fill="#fff" />
      <circle cx="8.5" cy="7.6" r="1.7" fill="#fff" />
      <path
        d="M13 11h2.9v1.4c.6-.9 1.7-1.6 3.2-1.6 2.4 0 3.9 1.5 3.9 4.4V21h-3v-5.2c0-1.3-.5-2.2-1.7-2.2-1 0-1.6.7-1.9 1.3-.1.3-.1.6-.1 1V21h-3z"
        fill="#fff"
      />
    </svg>
  ),
  TIKTOK: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#000" />
      <path
        d="M17.8 7.5c.5 1.5 1.6 2.6 3.2 2.9v2.5a5.9 5.9 0 0 1-3.2-1v5.7a4.7 4.7 0 1 1-4-4.6v2.6a2.1 2.1 0 1 0 1.6 2V7.5z"
        fill="#25F4EE"
      />
      <path
        d="M17 7.1c.5 1.5 1.6 2.6 3.2 2.9v2.5a5.9 5.9 0 0 1-3.2-1v5.7a4.7 4.7 0 1 1-4-4.6v2.6a2.1 2.1 0 1 0 1.6 2V7.1z"
        fill="#FE2C55"
        opacity="0.85"
      />
    </svg>
  ),
  YOUTUBE: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#FF0000" />
      <path d="M11.5 9.5v9l7.5-4.5z" fill="#fff" />
    </svg>
  ),
  GMAIL: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#fff" stroke="var(--border-hairline)" />
      <path d="M6 9.5 14 15l8-5.5V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z" fill="#EA4335" />
      <path
        d="M6 9.5V8.8A1.3 1.3 0 0 1 8 7.7L14 12l6-4.3a1.3 1.3 0 0 1 2 1.1v.7l-8 5.5z"
        fill="#FBBC05"
      />
      <path d="M6 8.8a1.3 1.3 0 0 1 2-1.1L14 12" fill="none" />
      <path d="M8 7.7 14 12l6-4.3" fill="none" stroke="#34A853" strokeWidth="1.1" />
      <path d="M14 12 8 7.7" fill="none" stroke="#4285F4" strokeWidth="1.1" />
    </svg>
  ),
  GOOGLE_CALENDAR: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect x="4" y="5" width="20" height="18" rx="3" fill="#fff" stroke="var(--border-hairline)" />
      <rect x="4" y="5" width="20" height="5" rx="3" fill="#4285F4" />
      <rect x="8" y="13" width="5" height="5" fill="#34A853" />
      <rect x="15" y="13" width="5" height="5" fill="#FBBC05" />
      <rect x="8" y="18.5" width="5" height="3.5" fill="#EA4335" />
    </svg>
  ),
  GOOGLE_BUSINESS: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#fff" stroke="var(--border-hairline)" />
      <rect x="6" y="12" width="16" height="9" rx="1.5" fill="#4285F4" />
      <rect
        x="10.5"
        y="8.5"
        width="7"
        height="5"
        rx="1"
        fill="none"
        stroke="#4285F4"
        strokeWidth="1.6"
      />
      <rect x="6" y="15.5" width="16" height="1.6" fill="#fff" opacity="0.6" />
    </svg>
  ),
  KEITARO: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="6" fill="#1D2733" />
      <path
        d="M7 20V9h2.6v4.6L13.8 9h3.2l-4.8 5.1L17.2 20h-3.1l-3.2-4.7-1.3 1.4V20z"
        fill="#3ED598"
      />
    </svg>
  ),
  MOCK: (
    <svg aria-hidden width="28" height="28" viewBox="0 0 28 28">
      <rect
        width="28"
        height="28"
        rx="6"
        fill="var(--surface-raised)"
        stroke="var(--border-hairline)"
      />
      <path
        d="M12 7h4M12.5 7v4.2L9 18a1.3 1.3 0 0 0 1.2 1.9h7.6A1.3 1.3 0 0 0 19 18l-3.5-6.8V7"
        fill="none"
        stroke="var(--ink-secondary)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10.8 15h6.4" stroke="var(--ink-secondary)" strokeWidth="1.4" />
    </svg>
  ),
};
