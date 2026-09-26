'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Mapping = RouterOutputs['fieldMapping']['list'][number];
type ObjectTypes = RouterOutputs['objectType']['list'];

/** Canonical entity kinds a connector's normalize() can yield (`@nexus/connector-sdk`'s
 * CANONICAL_KINDS) — hardcoded here rather than imported, since the SDK package pulls in
 * Node-only crypto at the top level and must never enter a client bundle. */
const SOURCE_KINDS = [
  'person',
  'company',
  'conversation',
  'message',
  'post',
  'engagement',
  'lead',
  'review',
  'metric',
  'conversion',
] as const;

type DraftRule = { sourceKind: string; sourcePath: string; attributeId: string; position: number };

export function MappingView({
  connectionId,
  platform,
  initialMappings,
  objectTypes,
}: {
  connectionId: string;
  platform: string;
  initialMappings: Mapping[];
  objectTypes: ObjectTypes;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: mappings } = useQuery({
    ...trpc.fieldMapping.list.queryOptions({ platform: platform as never }),
    initialData: initialMappings,
  });
  const invalidateMappings = () =>
    void qc.invalidateQueries({ queryKey: trpc.fieldMapping.list.pathKey() });

  const [selectedId, setSelectedId] = useState<string | null>(mappings[0]?.id ?? null);
  const selected = mappings.find((m) => m.id === selectedId) ?? null;
  const [draftRules, setDraftRules] = useState<DraftRule[]>(
    selected ? selected.rules.map((r) => ({ ...r, transform: undefined })) : [],
  );
  const [newName, setNewName] = useState('');
  const [previewKind, setPreviewKind] = useState('');

  const create = useMutation(
    trpc.fieldMapping.create.mutationOptions({
      onSuccess: (row) => {
        invalidateMappings();
        setSelectedId(row.id);
        setDraftRules([]);
        setNewName('');
      },
    }),
  );
  const assignMapping = useMutation(
    trpc.fieldMapping.assign.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.connection.get.pathKey() }),
    }),
  );
  const setRules = useMutation(
    trpc.fieldMapping.setRules.mutationOptions({ onSuccess: invalidateMappings }),
  );

  const previewInput =
    selected && previewKind.trim()
      ? {
          connectionId,
          kind: previewKind.trim(),
          rules: draftRules
            .filter((r) => r.sourcePath.trim() && r.attributeId)
            .map(({ sourceKind, sourcePath, attributeId }) => ({
              sourceKind,
              sourcePath,
              attributeId,
            })),
        }
      : null;
  const preview = useQuery({
    ...trpc.fieldMapping.preview.queryOptions(
      previewInput ?? { connectionId, kind: '__none__', rules: [] },
    ),
    enabled: previewInput !== null && previewInput.rules.length > 0,
  });

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-end gap-2 p-4">
        <label className="flex flex-col gap-1 text-[var(--text-sm)]">
          Mapping
          <select
            value={selectedId ?? ''}
            onChange={(e) => {
              const m = mappings.find((x) => x.id === e.target.value) ?? null;
              setSelectedId(m?.id ?? null);
              setDraftRules(m ? m.rules.map((r) => ({ ...r, transform: undefined })) : []);
            }}
            className="min-w-48 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5"
          >
            <option value="">— none —</option>
            {mappings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {selected ? (
          <Button
            size="sm"
            disabled={assignMapping.isPending}
            onClick={() => assignMapping.mutate({ connectionId, fieldMappingId: selected.id })}
          >
            Use for this connection
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={assignMapping.isPending}
          onClick={() => assignMapping.mutate({ connectionId, fieldMappingId: null })}
        >
          Use connector defaults
        </Button>
      </Card>

      <Card className="flex flex-wrap items-end gap-2 p-4">
        <label className="flex flex-col gap-1 text-[var(--text-sm)]">
          New mapping name
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="min-w-48 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5"
          />
        </label>
        <Button
          size="sm"
          disabled={create.isPending || !newName.trim()}
          onClick={() => create.mutate({ platform: platform as never, name: newName.trim() })}
        >
          {create.isPending ? 'Creating…' : 'Create mapping'}
        </Button>
      </Card>

      {selected ? (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Rules</h2>
          <div className="flex flex-col gap-2">
            {draftRules.map((rule, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Canonical entity kind"
                  value={rule.sourceKind}
                  onChange={(e) => {
                    const next = [...draftRules];
                    next[i] = { ...rule, sourceKind: e.target.value };
                    setDraftRules(next);
                  }}
                  className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5 text-[var(--text-sm)]"
                >
                  {SOURCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Source field path"
                  value={rule.sourcePath}
                  onChange={(e) => {
                    const next = [...draftRules];
                    next[i] = { ...rule, sourcePath: e.target.value };
                    setDraftRules(next);
                  }}
                  placeholder="source.path"
                  className="w-40 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5 font-mono text-[var(--text-sm)]"
                />
                <span aria-hidden className="text-ink-muted">
                  →
                </span>
                <AttributePicker
                  objectTypes={objectTypes}
                  value={rule.attributeId}
                  onChange={(attributeId) => {
                    const next = [...draftRules];
                    next[i] = { ...rule, attributeId };
                    setDraftRules(next);
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraftRules(draftRules.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() =>
                setDraftRules([
                  ...draftRules,
                  {
                    sourceKind: 'message',
                    sourcePath: '',
                    attributeId: '',
                    position: draftRules.length,
                  },
                ])
              }
            >
              Add rule
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={setRules.isPending}
              onClick={() =>
                setRules.mutate({
                  fieldMappingId: selected.id,
                  rules: draftRules
                    .filter((r) => r.sourcePath.trim() && r.attributeId)
                    .map((r, i) => ({ ...r, position: i })),
                })
              }
            >
              {setRules.isPending ? 'Saving…' : 'Save rules'}
            </Button>
            {setRules.error ? (
              <span role="alert" className="text-[var(--text-sm)] text-critical">
                {setRules.error.message}
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-hairline pt-3">
            <label className="flex flex-col gap-1 text-[var(--text-sm)]">
              Preview against raw objects of kind
              <input
                value={previewKind}
                onChange={(e) => setPreviewKind(e.target.value)}
                placeholder="e.g. ig_comment"
                className="w-48 rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5 font-mono"
              />
            </label>
            {preview.data ? (
              preview.data.length === 0 ? (
                <p className="text-[var(--text-sm)] text-ink-muted">
                  No stored objects of that kind yet for this connection.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {preview.data.map((sample, i) => (
                    <div
                      key={i}
                      className="rounded-[var(--radius-control)] border border-hairline p-2 text-[var(--text-xs)]"
                    >
                      {draftRules
                        .filter((r) => r.attributeId)
                        .map((r) => (
                          <p key={r.attributeId}>
                            <span className="text-ink-muted">{r.sourcePath}:</span>{' '}
                            <span className="font-mono">
                              {JSON.stringify(sample.mapped[r.attributeId])}
                            </span>
                          </p>
                        ))}
                    </div>
                  ))}
                </div>
              )
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function AttributePicker({
  objectTypes,
  value,
  onChange,
}: {
  objectTypes: ObjectTypes;
  value: string;
  onChange: (attributeId: string) => void;
}) {
  const trpc = useTRPC();
  const [objectTypeSlug, setObjectTypeSlug] = useState(objectTypes[0]?.apiSlug ?? '');
  const { data: attributes } = useQuery({
    ...trpc.attribute.list.queryOptions({ objectType: objectTypeSlug }),
    enabled: Boolean(objectTypeSlug),
  });
  return (
    <span className="flex items-center gap-1">
      <select
        aria-label="Target object type"
        value={objectTypeSlug}
        onChange={(e) => setObjectTypeSlug(e.target.value)}
        className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5 text-[var(--text-sm)]"
      >
        {objectTypes.map((ot) => (
          <option key={ot.id} value={ot.apiSlug}>
            {ot.singular}
          </option>
        ))}
      </select>
      <select
        aria-label="Target attribute"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5 text-[var(--text-sm)]"
      >
        <option value="">— attribute —</option>
        {(attributes ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.title}
          </option>
        ))}
      </select>
    </span>
  );
}
