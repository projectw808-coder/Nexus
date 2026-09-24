'use client';

import { useId, useSyncExternalStore } from 'react';
import { applyTheme, readStoredTheme, THEMES, type Theme } from '@nexus/ui';

const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

// A tiny external store over localStorage/cookie so the control re-reads the persisted theme
// after hydration and follows changes made in other tabs (the `storage` event) without
// setting state inside an effect.
const listeners = new Set<() => void>();
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}
function notify(): void {
  for (const l of listeners) l();
}

/**
 * Three-state theme control. Keyboard: arrow keys move between options (native radio
 * behaviour), Space/Enter select. The choice persists in localStorage + a cookie so the
 * server renders the same theme on the next request (§12.3, Phase 0 acceptance).
 */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const theme = useSyncExternalStore(
    subscribe,
    () => readStoredTheme(),
    () => initial,
  );
  const groupId = useId();

  const choose = (next: Theme) => {
    applyTheme(next);
    notify();
  };

  return (
    <fieldset
      className="flex items-center gap-1 rounded-[var(--radius-control)] border border-hairline p-0.5"
      aria-label="Colour theme"
    >
      {THEMES.map((t) => {
        const id = `${groupId}-${t}`;
        const active = theme === t;
        return (
          <label
            key={t}
            htmlFor={id}
            className={[
              'cursor-pointer select-none rounded-[4px] px-2 py-0.5 text-[var(--text-sm)]',
              'transition-colors duration-[var(--duration-state)] ease-[var(--ease-standard)]',
              'has-[:focus-visible]:shadow-[var(--focus-ring)]',
              active ? 'bg-ink text-ink-inverse' : 'text-ink-secondary hover:text-ink',
            ].join(' ')}
          >
            <input
              id={id}
              type="radio"
              name={`${groupId}-theme`}
              value={t}
              checked={active}
              onChange={() => choose(t)}
              className="sr-only"
            />
            {LABEL[t]}
          </label>
        );
      })}
    </fieldset>
  );
}
