'use client';

import { useEffect, useRef } from 'react';
import { CONTROL_CLASS } from '@/components/field';

/**
 * Workspace-bar search (§11.1 `search`): a GET form to `/w/[slug]/search?q=`, so it works
 * without JavaScript and every result page is a link. `/` focuses it from anywhere outside a
 * text field. The ⌘K palette is Phase 3.
 */
export function GlobalSearch({ slug, initialQuery }: { slug: string; initialQuery?: string }) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      method="get"
      action={`/w/${slug}/search`}
      role="search"
      className="hidden min-w-0 flex-1 items-center justify-center md:flex"
    >
      <label htmlFor="global-search" className="sr-only">
        Search records
      </label>
      <div className="relative w-full max-w-md">
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
        >
          <circle cx="9" cy="9" r="5.5" />
          <path d="M13 13l4 4" strokeLinecap="round" />
        </svg>
        <input
          ref={ref}
          id="global-search"
          name="q"
          type="search"
          defaultValue={initialQuery ?? ''}
          placeholder="Search records…  /"
          autoComplete="off"
          maxLength={200}
          className={`${CONTROL_CLASS} h-8 pl-8 text-[var(--text-sm)]`}
        />
      </div>
    </form>
  );
}
