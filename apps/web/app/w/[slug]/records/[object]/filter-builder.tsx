'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { filterOpsFor, type FilterOp } from '@nexus/core';
import { Button } from '@/components/button';
import { CONTROL_CLASS } from '@/components/field';
import { optionsOf, type AttributeLike } from '@/lib/attributes';
import {
  OP_LABEL,
  opNeedsValue,
  opTakesList,
  SYSTEM_COLUMNS,
  tableHref,
  withoutCursor,
  type TableQuery,
  type UrlFilter,
} from '@/lib/record-query';

const SYSTEM_OPS: readonly FilterOp[] = ['gt', 'gte', 'lt', 'lte', 'eq'];

/**
 * Filter builder: attribute → operator (per type, via `filterOpsFor`) → value, then the URL
 * changes. Applied filters are chips with a remove link. The state lives in the address, so
 * this island only composes hrefs.
 */
export function FilterBuilder({
  base,
  query,
  attributes,
}: {
  base: string;
  query: TableQuery;
  attributes: AttributeLike[];
}) {
  const router = useRouter();
  const id = useId();
  const [attrKey, setAttrKey] = useState(attributes[0]?.apiSlug ?? 'createdAt');
  const attr = attributes.find((a) => a.apiSlug === attrKey);
  const ops: readonly FilterOp[] = attr ? filterOpsFor(attr.type) : SYSTEM_OPS;
  const [op, setOp] = useState<FilterOp>(ops[0] ?? 'eq');
  const effectiveOp = ops.includes(op) ? op : (ops[0] ?? 'eq');
  const [value, setValue] = useState('');

  const options = attr ? optionsOf(attr.config) : [];
  const needsValue = opNeedsValue(effectiveOp);
  const list = opTakesList(effectiveOp);

  const add = () => {
    const f: UrlFilter = {
      attribute: attrKey,
      op: effectiveOp,
      value: needsValue ? value.trim() : '',
    };
    if (needsValue && !f.value) return;
    const next = withoutCursor({ ...query, filters: [...query.filters, f] });
    router.push(tableHref(base, next));
    setValue('');
  };

  const labelOf = (f: UrlFilter) => {
    const a = attributes.find((x) => x.apiSlug === f.attribute || x.id === f.attribute);
    const title = a?.title ?? f.attribute;
    if (!opNeedsValue(f.op)) return `${title} ${OP_LABEL[f.op]}`;
    const shown = a
      ? f.value
          .split(',')
          .map((v) => optionsOf(a.config).find((o) => o.id === v.trim())?.label ?? v.trim())
          .join(', ')
      : f.value;
    return `${title} ${OP_LABEL[f.op]} ${shown}`;
  };

  return (
    <div className="flex flex-col gap-2">
      {query.filters.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Applied filters">
          {query.filters.map((f, i) => (
            <li
              key={`${f.attribute}:${f.op}:${f.value}:${i}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-pill)] border border-hairline bg-card pl-2.5 pr-1 text-[var(--text-xs)]"
            >
              <span>{labelOf(f)}</span>
              <Link
                href={tableHref(
                  base,
                  withoutCursor({ ...query, filters: query.filters.filter((_, j) => j !== i) }),
                )}
                aria-label={`Remove filter: ${labelOf(f)}`}
                className="flex size-5 items-center justify-center rounded-[var(--radius-pill)] hover:bg-raised"
              >
                ×
              </Link>
            </li>
          ))}
          <li>
            <Link
              href={tableHref(base, withoutCursor({ ...query, filters: [] }))}
              className="text-[var(--text-xs)] text-ink-secondary underline-offset-2 hover:underline"
            >
              Clear all
            </Link>
          </li>
        </ul>
      ) : null}
      <details className="group">
        <summary className="cursor-pointer text-[var(--text-sm)] text-ink-secondary hover:text-ink">
          <span className="group-open:hidden">+ Add filter</span>
          <span className="hidden group-open:inline">− Hide filter builder</span>
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-[var(--radius-card)] border border-hairline bg-card p-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${id}-attr`}
              className="text-[var(--text-xs)] font-medium text-ink-muted"
            >
              Attribute
            </label>
            <select
              id={`${id}-attr`}
              value={attrKey}
              onChange={(e) => {
                setAttrKey(e.target.value);
                setValue('');
              }}
              className={`${CONTROL_CLASS} w-48`}
            >
              {attributes.map((a) => (
                <option key={a.id} value={a.apiSlug}>
                  {a.title}
                </option>
              ))}
              {SYSTEM_COLUMNS.map((c) => (
                <option key={c} value={c}>
                  {c === 'createdAt' ? 'Created' : 'Updated'}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${id}-op`}
              className="text-[var(--text-xs)] font-medium text-ink-muted"
            >
              Operator
            </label>
            <select
              id={`${id}-op`}
              value={effectiveOp}
              onChange={(e) => setOp(e.target.value as FilterOp)}
              className={`${CONTROL_CLASS} w-40`}
            >
              {ops.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o]}
                </option>
              ))}
            </select>
          </div>
          {needsValue ? (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor={`${id}-value`}
                className="text-[var(--text-xs)] font-medium text-ink-muted"
              >
                Value{list ? ' (comma-separated)' : ''}
              </label>
              {attr && options.length > 0 && !list ? (
                <select
                  id={`${id}-value`}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={`${CONTROL_CLASS} w-48`}
                >
                  <option value="">Choose…</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : attr?.type === 'BOOLEAN' ? (
                <select
                  id={`${id}-value`}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={`${CONTROL_CLASS} w-32`}
                >
                  <option value="">Choose…</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  id={`${id}-value`}
                  type={
                    attr?.type === 'DATE' && !list
                      ? 'date'
                      : attr?.type === 'DATETIME' && !list
                        ? 'datetime-local'
                        : 'text'
                  }
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      add();
                    }
                  }}
                  placeholder={
                    list && options.length
                      ? options
                          .map((o) => o.id)
                          .slice(0, 3)
                          .join(',')
                      : undefined
                  }
                  className={`${CONTROL_CLASS} w-56`}
                />
              )}
            </div>
          ) : null}
          <Button variant="secondary" onClick={add} disabled={needsValue && !value.trim()}>
            Apply
          </Button>
        </div>
      </details>
    </div>
  );
}
