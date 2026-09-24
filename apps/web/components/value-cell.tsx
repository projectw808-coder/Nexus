import Link from 'next/link';
import type { Option } from '@nexus/core';
import { LocalDateTime } from '@/components/local-time';
import {
  currencyOf,
  formatCurrency,
  formatNumber,
  isMultiple,
  optionsOf,
  ratingMaxOf,
  swatchColor,
  targetObjectTypeIdOf,
  type AttributeLike,
} from '@/lib/attributes';

const dateOnly = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export function Empty() {
  return <span className="text-ink-muted">—</span>;
}

/** An option with its colour swatch. The label always accompanies the colour. */
export function OptionChip({ option, index }: { option: Option; index: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden
        className="inline-block size-2.5 shrink-0 rounded-full border border-hairline"
        style={{ background: swatchColor(option, index) }}
      />
      <span>{option.label}</span>
    </span>
  );
}

function OptionValue({ config, id }: { config: Record<string, unknown>; id: unknown }) {
  if (typeof id !== 'string') return <Empty />;
  const options = optionsOf(config);
  const index = options.findIndex((o) => o.id === id);
  const option = options[index];
  if (!option) return <span className="font-mono text-[var(--text-xs)]">{id}</span>;
  return <OptionChip option={option} index={index} />;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function locationText(v: unknown): string {
  if (!v || typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  return ['address', 'city', 'region', 'postalCode', 'country']
    .map((k) => o[k])
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(', ');
}

/**
 * One record value rendered per attribute type (§6.2). Server-renderable; only DATETIME uses a
 * client island so it can show the viewer's time zone. `objectSlugById` turns RELATIONSHIP ids
 * into links to the target object's records.
 */
export function ValueCell({
  attribute,
  value,
  slug,
  objectSlugById,
  full,
}: {
  attribute: AttributeLike;
  value: unknown;
  slug: string;
  objectSlugById?: Record<string, string>;
  /** Detail view: no truncation, every item listed. */
  full?: boolean;
}) {
  if (value === null || value === undefined || value === '') return <Empty />;
  const c = attribute.config;
  switch (attribute.type) {
    case 'TEXT':
    case 'PHONE':
    case 'SOCIAL_HANDLE':
      return typeof value === 'string' ? (
        <span className={full ? 'whitespace-pre-wrap' : 'block max-w-[24rem] truncate'}>
          {value}
        </span>
      ) : (
        <Raw value={value} />
      );
    case 'EMAIL':
      return typeof value === 'string' ? (
        <a href={`mailto:${value}`} className="text-link underline-offset-2 hover:underline">
          {value}
        </a>
      ) : (
        <Raw value={value} />
      );
    case 'URL':
      return typeof value === 'string' ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer noopener"
          className="block max-w-[20rem] truncate text-link underline-offset-2 hover:underline"
        >
          {value.replace(/^https?:\/\//, '')}
        </a>
      ) : (
        <Raw value={value} />
      );
    case 'NUMBER':
      return typeof value === 'number' ? (
        <span className="tnum">{formatNumber(value)}</span>
      ) : (
        <Raw value={value} />
      );
    case 'CURRENCY':
      return typeof value === 'number' ? (
        <span className="tnum">{formatCurrency(value, currencyOf(c))}</span>
      ) : (
        <Raw value={value} />
      );
    case 'RATING': {
      if (typeof value !== 'number') return <Raw value={value} />;
      const max = ratingMaxOf(c);
      return (
        <span className="tnum" aria-label={`${value} of ${max}`}>
          <span aria-hidden>
            {'★'.repeat(Math.min(value, max)) + '☆'.repeat(Math.max(max - value, 0))}
          </span>
          <span className="sr-only">
            {value} of {max}
          </span>
        </span>
      );
    }
    case 'DATE': {
      if (typeof value !== 'string') return <Raw value={value} />;
      const d = new Date(`${value}T00:00:00Z`);
      return <time dateTime={value}>{Number.isNaN(d.getTime()) ? value : dateOnly.format(d)}</time>;
    }
    case 'DATETIME':
      return typeof value === 'string' ? <LocalDateTime iso={value} /> : <Raw value={value} />;
    case 'SELECT':
    case 'STATUS':
      return <OptionValue config={c} id={value} />;
    case 'MULTISELECT': {
      const ids = stringList(value);
      if (ids.length === 0) return <Empty />;
      const shown = full ? ids : ids.slice(0, 3);
      return (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {shown.map((id) => (
            <OptionValue key={id} config={c} id={id} />
          ))}
          {ids.length > shown.length ? (
            <span className="text-ink-muted">+{ids.length - shown.length}</span>
          ) : null}
        </span>
      );
    }
    case 'BOOLEAN':
      return value === true ? (
        <span>
          <span aria-hidden>✓</span>
          <span className="sr-only">Yes</span>
        </span>
      ) : (
        <span>
          <span aria-hidden>—</span>
          <span className="sr-only">No</span>
        </span>
      );
    case 'RELATIONSHIP': {
      const ids = stringList(value);
      if (ids.length === 0) return <Empty />;
      const target = targetObjectTypeIdOf(c);
      const targetSlug = target ? objectSlugById?.[target] : undefined;
      const shown = full ? ids : ids.slice(0, 2);
      return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {shown.map((id) =>
            targetSlug ? (
              <Link
                key={id}
                href={`/w/${slug}/records/${targetSlug}/${id}`}
                className="font-mono text-[var(--text-xs)] text-link underline-offset-2 hover:underline"
                title={id}
              >
                {id.slice(0, 8)}
              </Link>
            ) : (
              <span key={id} className="font-mono text-[var(--text-xs)]" title={id}>
                {id.slice(0, 8)}
              </span>
            ),
          )}
          {ids.length > shown.length ? (
            <span className="text-ink-muted">+{ids.length - shown.length}</span>
          ) : isMultiple(c) && !full ? (
            <span className="text-ink-muted">({ids.length} linked)</span>
          ) : null}
        </span>
      );
    }
    case 'USER': {
      const ids = stringList(value);
      if (ids.length === 0) return <Empty />;
      return (
        <span className="flex flex-wrap gap-x-2">
          {ids.map((id) => (
            <span key={id} className="font-mono text-[var(--text-xs)]" title={id}>
              {id.slice(0, 8)}
            </span>
          ))}
        </span>
      );
    }
    case 'LOCATION': {
      const t = locationText(value);
      return t ? (
        <span className={full ? '' : 'block max-w-[20rem] truncate'}>{t}</span>
      ) : (
        <Empty />
      );
    }
    case 'AI_RESEARCH': {
      if (!value || typeof value !== 'object') return <Raw value={value} />;
      const v = (value as { value?: unknown }).value;
      return v === null || v === undefined ? <Empty /> : <Raw value={v} />;
    }
    case 'FORMULA':
    case 'ROLLUP':
      return <Raw value={value} />;
  }
}

function Raw({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <Empty />;
  if (typeof value === 'string') return <span>{value}</span>;
  if (typeof value === 'number') return <span className="tnum">{formatNumber(value)}</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  return <code className="font-mono text-[var(--text-xs)]">{JSON.stringify(value)}</code>;
}
