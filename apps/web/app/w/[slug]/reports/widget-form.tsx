'use client';

/**
 * Add/edit one widget. The form is driven by the DSL rather than hard-coded twice: pick a kind,
 * and `SOURCES_FOR_KIND` narrows the data sources; pick a source, and the variant's own fields
 * appear. Filters and sort use the shared vocabulary through a JSON escape hatch — the same
 * precedent the automation builder set for conditions and actions — so Reports never grows a
 * second filter language.
 *
 * A live preview runs the unsaved query through `widget.data`, so you see the actual chart
 * (legend, labels, palette and all) before you save.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  REPORT_PLATFORMS,
  SOURCES_FOR_KIND,
  TIMELINE_TYPES,
  WIDGET_KINDS,
  defaultQueryFor,
  parseWidgetQuery,
  type WidgetKind,
  type WidgetQuery,
  type WidgetSource,
} from '@nexus/core';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { WidgetChart } from '@/components/charts';
import { CONTROL_CLASS, Field } from '@/components/field';
import { useTRPC } from '@/lib/trpc-client';

export type FormObject = {
  apiSlug: string;
  plural: string;
  attributes: { apiSlug: string; title: string; type: string }[];
};
export type FormList = { id: string; name: string; kind: string };

const KIND_LABEL: Record<WidgetKind, string> = {
  STAT_TILE: 'Stat tile',
  LINE: 'Line',
  BAR: 'Bar',
  STACKED_BAR: 'Stacked bar',
  FUNNEL: 'Funnel',
  COHORT_HEATMAP: 'Cohort heatmap',
  TABLE: 'Table',
};

const SOURCE_LABEL: Record<WidgetSource, string> = {
  record_count: 'Records — count',
  timeline_count: 'Timeline — event count',
  sentiment_over_time: 'AI — sentiment over time',
  pipeline_funnel: 'Pipeline — entries per stage',
  record_table: 'Records — table',
  cohort_retention: 'Records — cohort retention',
};

/** Grouping into series is what makes a stack; a stacked bar without one is just a bar. */
const GROUP_BY = ['none', 'platform', 'type'] as const;

export function WidgetForm({
  slug,
  dashboardId,
  objects,
  lists,
  widget,
}: {
  slug: string;
  dashboardId: string;
  objects: FormObject[];
  lists: FormList[];
  widget?: { id: string; kind: WidgetKind; title: string; query: unknown };
}) {
  const trpc = useTRPC();
  const router = useRouter();
  const initial = widget ? parseWidgetQuery(widget.query) : null;

  const [kind, setKind] = useState<WidgetKind>(widget?.kind ?? 'STAT_TILE');
  const [title, setTitle] = useState(widget?.title ?? '');
  const [query, setQuery] = useState<WidgetQuery>(
    initial?.ok ? initial.query : defaultQueryFor(widget?.kind ?? 'STAT_TILE'),
  );
  const [error, setError] = useState<string | null>(null);

  const allowed = SOURCES_FOR_KIND[kind];
  const patch = (p: Record<string, unknown>) => setQuery((q) => ({ ...q, ...p }));

  const pickKind = (next: WidgetKind) => {
    setKind(next);
    // Keep the query when the new kind can still draw it; otherwise start from its default.
    if (!SOURCES_FOR_KIND[next].includes(query.source)) setQuery(defaultQueryFor(next));
  };

  const pickSource = (source: WidgetSource) => {
    if (source === query.source) return;
    const seed = WIDGET_KINDS.map((k) => defaultQueryFor(k)).find((q) => q.source === source);
    setQuery(seed ?? defaultQueryFor(kind));
  };

  const preview = useQuery(
    trpc.widget.data.queryOptions({ kind, query }, { retry: false, staleTime: 0 }),
  );

  const onDone = () => {
    router.push(`/w/${slug}/reports/${dashboardId}`);
    router.refresh();
  };
  const create = useMutation(
    trpc.widget.create.mutationOptions({ onSuccess: onDone, onError: (e) => setError(e.message) }),
  );
  const update = useMutation(
    trpc.widget.update.mutationOptions({ onSuccess: onDone, onError: (e) => setError(e.message) }),
  );
  const busy = create.isPending || update.isPending;

  const submit = () => {
    setError(null);
    if (widget) update.mutate({ id: widget.id, kind, title, query });
    else create.mutate({ dashboardId, kind, title, query });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <Card className="flex flex-col gap-4 p-4">
        <Field id="widget-title" label="Title">
          <input
            id="widget-title"
            className={CONTROL_CLASS}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Messages today"
          />
        </Field>

        <Field id="widget-kind" label="Widget" hint="The catalogue is fixed (§12.2.E).">
          <select
            id="widget-kind"
            className={CONTROL_CLASS}
            value={kind}
            onChange={(e) => pickKind(e.target.value as WidgetKind)}
          >
            {WIDGET_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id="widget-source"
          label="Data source"
          hint={`A ${KIND_LABEL[kind].toLowerCase()} can draw ${allowed.length} of the six sources.`}
        >
          <select
            id="widget-source"
            className={CONTROL_CLASS}
            value={query.source}
            onChange={(e) => pickSource(e.target.value as WidgetSource)}
          >
            {allowed.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>

        <SourceFields query={query} patch={patch} objects={objects} lists={lists} />

        {error ? (
          <p role="alert" className="text-[var(--text-sm)] text-critical">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={busy || title.trim().length === 0} onClick={submit}>
            {busy ? 'Saving…' : widget ? 'Save widget' : 'Add widget'}
          </Button>
          <Button onClick={() => router.push(`/w/${slug}/reports/${dashboardId}`)}>Cancel</Button>
        </div>
      </Card>

      <div className="flex flex-col gap-2">
        <h2 className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
          Preview
        </h2>
        {preview.isPending ? (
          <Card className="p-4 text-[var(--text-sm)] text-ink-muted">Running the query…</Card>
        ) : preview.error ? (
          <Card className="p-4" style={{ borderColor: 'var(--status-critical)' }}>
            <p role="alert" className="text-[var(--text-sm)] text-ink-secondary">
              {preview.error.message}
            </p>
          </Card>
        ) : (
          <WidgetChart
            kind={kind}
            title={title.trim() || KIND_LABEL[kind]}
            result={preview.data.result}
          />
        )}
      </div>
    </div>
  );
}

// ── per-variant fields ────────────────────────────────────────────────────────

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field id={id} label={label} {...(hint ? { hint } : {})}>
      <input
        id={id}
        type="number"
        className={CONTROL_CLASS}
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      />
    </Field>
  );
}

function Checkbox({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-[var(--text-sm)]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

function MultiSelect({
  id,
  label,
  hint,
  options,
  selected,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <Field id={id} label={label} {...(hint ? { hint } : {})}>
      <div
        id={id}
        className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-auto rounded-[var(--radius-control)] border border-hairline bg-raised p-2"
      >
        {options.map((o) => (
          <label
            key={o.value}
            className="flex items-center gap-1.5 text-[var(--text-xs)] text-ink-secondary"
          >
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value),
                )
              }
            />
            {o.label}
          </label>
        ))}
      </div>
    </Field>
  );
}

function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? [], null, 2));
  const [bad, setBad] = useState<string | null>(null);
  return (
    <Field id={id} label={label} hint={hint} {...(bad ? { error: bad } : {})}>
      <textarea
        id={id}
        rows={3}
        spellCheck={false}
        className="w-full rounded-[var(--radius-control)] border border-hairline bg-raised p-2 font-mono text-[var(--text-xs)]"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value || '[]'));
            setBad(null);
          } catch {
            setBad('That is not valid JSON yet.');
          }
        }}
      />
    </Field>
  );
}

function ObjectSelect({
  value,
  objects,
  onChange,
}: {
  value: string;
  objects: FormObject[];
  onChange: (v: string) => void;
}) {
  return (
    <Field id="widget-object" label="Object">
      <select
        id="widget-object"
        className={CONTROL_CLASS}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {objects.map((o) => (
          <option key={o.apiSlug} value={o.apiSlug}>
            {o.plural}
          </option>
        ))}
      </select>
    </Field>
  );
}

const FILTER_HINT =
  'The shared filter vocabulary, e.g. [{"attribute":"stage","op":"eq","value":"won"}].';

function SourceFields({
  query,
  patch,
  objects,
  lists,
}: {
  query: WidgetQuery;
  patch: (p: Record<string, unknown>) => void;
  objects: FormObject[];
  lists: FormList[];
}) {
  const typeOptions = useMemo(
    () => TIMELINE_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ').toLowerCase() })),
    [],
  );
  const platformOptions = useMemo(
    () => REPORT_PLATFORMS.map((p) => ({ value: p, label: p.replace(/_/g, ' ').toLowerCase() })),
    [],
  );

  switch (query.source) {
    case 'record_count': {
      const attrs = objects.find((o) => o.apiSlug === query.objectTypeApiSlug)?.attributes ?? [];
      return (
        <>
          <ObjectSelect
            value={query.objectTypeApiSlug}
            objects={objects}
            onChange={(v) => patch({ objectTypeApiSlug: v, groupByAttribute: undefined })}
          />
          <Field
            id="widget-group"
            label="Group into series by"
            hint="A SELECT or STATUS attribute. Leave empty for one series."
          >
            <select
              id="widget-group"
              className={CONTROL_CLASS}
              value={query.groupByAttribute ?? ''}
              onChange={(e) => patch({ groupByAttribute: e.target.value || undefined })}
            >
              <option value="">No grouping</option>
              {attrs
                .filter((a) => a.type === 'SELECT' || a.type === 'STATUS')
                .map((a) => (
                  <option key={a.apiSlug} value={a.apiSlug}>
                    {a.title}
                  </option>
                ))}
            </select>
          </Field>
          <Checkbox
            id="widget-byday"
            label="Bucket by day of creation"
            checked={query.byDay}
            onChange={(v) => patch({ byDay: v })}
          />
          {query.byDay ? (
            <NumberField
              id="widget-days"
              label="Days"
              value={query.days}
              min={1}
              max={400}
              onChange={(v) => patch({ days: v })}
            />
          ) : null}
          <JsonField
            id="widget-filters"
            label="Filters"
            hint={FILTER_HINT}
            value={query.filters}
            onChange={(v) => patch({ filters: v })}
          />
        </>
      );
    }
    case 'timeline_count':
      return (
        <>
          <MultiSelect
            id="widget-types"
            label="Event types"
            hint="Empty means every type."
            options={typeOptions}
            selected={query.types}
            onChange={(v) => patch({ types: v })}
          />
          <MultiSelect
            id="widget-platforms"
            label="Platforms"
            hint="Empty means every platform."
            options={platformOptions}
            selected={query.platforms}
            onChange={(v) => patch({ platforms: v })}
          />
          <Field id="widget-groupby" label="Group into series by">
            <select
              id="widget-groupby"
              className={CONTROL_CLASS}
              value={query.groupBy}
              onChange={(e) => patch({ groupBy: e.target.value })}
            >
              {GROUP_BY.map((g) => (
                <option key={g} value={g}>
                  {g === 'none' ? 'No grouping' : g}
                </option>
              ))}
            </select>
          </Field>
          <Checkbox
            id="widget-byday"
            label="Bucket by day (off puts the groups on the x axis)"
            checked={query.byDay}
            onChange={(v) => patch({ byDay: v })}
          />
          <NumberField
            id="widget-days"
            label="Days"
            hint="A stat tile compares this window with the one immediately before it."
            value={query.days}
            min={1}
            max={400}
            onChange={(v) => patch({ days: v })}
          />
        </>
      );
    case 'sentiment_over_time':
      return (
        <NumberField
          id="widget-days"
          label="Days"
          hint="Reads AI summaries directly — there is no daily rollup, so the window is capped at 120 days."
          value={query.days}
          min={1}
          max={120}
          onChange={(v) => patch({ days: v })}
        />
      );
    case 'pipeline_funnel': {
      const pipelines = lists.filter((l) => l.kind === 'PIPELINE');
      return (
        <Field
          id="widget-list"
          label="Pipeline"
          hint={
            pipelines.length === 0 ? 'No pipelines exist yet — create one under Lists.' : undefined
          }
        >
          <select
            id="widget-list"
            className={CONTROL_CLASS}
            value={query.listId}
            onChange={(e) => patch({ listId: e.target.value })}
          >
            <option value="00000000-0000-0000-0000-000000000000">Choose a pipeline…</option>
            {pipelines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
      );
    }
    case 'record_table': {
      const attrs = objects.find((o) => o.apiSlug === query.objectTypeApiSlug)?.attributes ?? [];
      return (
        <>
          <ObjectSelect
            value={query.objectTypeApiSlug}
            objects={objects}
            onChange={(v) => patch({ objectTypeApiSlug: v, columns: [] })}
          />
          <MultiSelect
            id="widget-columns"
            label="Columns"
            hint="Empty means the first five attributes."
            options={attrs.map((a) => ({ value: a.apiSlug, label: a.title }))}
            selected={query.columns}
            onChange={(v) => patch({ columns: v })}
          />
          <NumberField
            id="widget-limit"
            label="Rows"
            value={query.limit}
            min={1}
            max={200}
            onChange={(v) => patch({ limit: v })}
          />
          <JsonField
            id="widget-filters"
            label="Filters"
            hint={FILTER_HINT}
            value={query.filters}
            onChange={(v) => patch({ filters: v })}
          />
          <JsonField
            id="widget-sort"
            label="Sort"
            hint='e.g. [{"attribute":"createdAt","direction":"desc"}].'
            value={query.sort}
            onChange={(v) => patch({ sort: v })}
          />
        </>
      );
    }
    case 'cohort_retention':
      return (
        <>
          <ObjectSelect
            value={query.objectTypeApiSlug}
            objects={objects}
            onChange={(v) => patch({ objectTypeApiSlug: v })}
          />
          <NumberField
            id="widget-weeks"
            label="Weeks"
            hint="Cohorts are the ISO week a record was created in."
            value={query.weeks}
            min={2}
            max={26}
            onChange={(v) => patch({ weeks: v })}
          />
          <MultiSelect
            id="widget-activity"
            label="What counts as activity"
            hint="Empty means any timeline event."
            options={typeOptions}
            selected={query.activityTypes}
            onChange={(v) => patch({ activityTypes: v })}
          />
        </>
      );
  }
}
