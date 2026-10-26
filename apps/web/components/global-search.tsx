'use client';

import { useEffect, useRef } from 'react';
import { Search } from 'lucide-react';

/**
 * Workspace-bar search (§11.1 `search`): a GET form to `/w/[slug]/search?q=`, so it works
 * without JavaScript and every result page is a link. `/` focuses it from anywhere outside a
 * text field; ⌘K opens the command palette.
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
        Search clients and records
      </label>
      <div className="relative w-full max-w-[566px]">
        <Search
          aria-hidden
          size={17}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted"
        />
        <input
          ref={ref}
          id="global-search"
          name="q"
          type="search"
          defaultValue={initialQuery ?? ''}
          placeholder="Search clients, phone, email, notes..."
          autoComplete="off"
          maxLength={200}
          className="h-[41px] w-full rounded-[7px] border border-strong bg-raised pl-11 pr-16 text-[13px] text-ink placeholder:text-ink-muted focus:border-link focus:outline-none"
        />
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-[5px] border border-strong px-1.5 py-0.5 font-sans text-[11px] text-ink-muted"
        >
          ⌘ K
        </kbd>
      </div>
    </form>
  );
}
