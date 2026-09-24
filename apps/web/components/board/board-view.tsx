'use client';

/**
 * Pipeline board (§12.2.D): one column per stage, cards draggable between and within stages
 * (dnd-kit pointer + keyboard sensors), WIP limits and stage-rot highlighting. Every drag has a
 * keyboard route: the card's "Move" menu picks a stage or nudges the order, and dnd-kit's own
 * keyboard sensor (Space to lift, arrows to move, Space to drop) works too.
 */
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Skeleton } from '@/components/skeleton';
import { StatusPill } from '@/components/status-pill';
import { useTRPC } from '@/lib/trpc-client';

type Stage = { id: string; label: string; color?: string; category?: string };
type Entry = {
  id: string;
  recordId: string;
  label: string;
  stage: string | null;
  position: number;
  enteredStageAt: string;
};

export function BoardView({
  slug,
  listId,
  objectSlug,
  canMove,
}: {
  slug: string;
  listId: string;
  objectSlug: string;
  canMove: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const query = useQuery(trpc.list.get.queryOptions({ id: listId }));
  const key = trpc.list.get.queryKey({ id: listId });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = useMutation(
    trpc.listEntry.move.mutationOptions({
      onError: (e) => {
        setNotice(e.message);
        void qc.invalidateQueries({ queryKey: key });
      },
    }),
  );

  const data = query.data;
  const stages: Stage[] = useMemo(() => data?.stages ?? [], [data]);
  const byStage = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const s of stages) map.set(s.id, []);
    for (const e of data?.entries ?? []) {
      const k = e.stage ?? stages[0]?.id ?? '';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position);
    return map;
  }, [data, stages]);

  const applyLocal = (entryId: string, stage: string, index: number) => {
    qc.setQueryData(key, (old: typeof data) => {
      if (!old) return old;
      const others = old.entries.filter((e) => e.id !== entryId);
      const moving = old.entries.find((e) => e.id === entryId);
      if (!moving) return old;
      const inStage = others
        .filter((e) => e.stage === stage)
        .sort((a, b) => a.position - b.position);
      const before = inStage[index - 1]?.position ?? null;
      const after = inStage[index]?.position ?? null;
      const position =
        before === null && after === null
          ? 1024
          : before === null
            ? (after as number) - 1
            : after === null
              ? before + 1
              : (before + after) / 2;
      return {
        ...old,
        entries: [
          ...others,
          {
            ...moving,
            stage,
            position,
            enteredStageAt:
              stage === moving.stage ? moving.enteredStageAt : new Date().toISOString(),
          },
        ],
      };
    });
  };

  const persist = (entryId: string, stage: string, index: number) => {
    const list = (byStage.get(stage) ?? []).filter((e) => e.id !== entryId);
    const afterEntryId = list[index - 1]?.id ?? null;
    const beforeEntryId = list[index]?.id ?? null;
    applyLocal(entryId, stage, index);
    move.mutate({ entryId, stage, afterEntryId, beforeEntryId });
  };

  const findStageOf = (id: string): string | undefined => {
    if (byStage.has(id)) return id;
    for (const [s, arr] of byStage) if (arr.some((e) => e.id === id)) return s;
    return undefined;
  };

  const onDragOver = (e: DragOverEvent) => {
    const overId = e.over?.id;
    if (!overId || !activeId) return;
    const from = findStageOf(activeId);
    const to = findStageOf(String(overId));
    if (!from || !to || from === to) return;
    const arr = byStage.get(to) ?? [];
    const idx = arr.findIndex((x) => x.id === overId);
    applyLocal(activeId, to, idx < 0 ? arr.length : idx);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    setActiveId(null);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const to = findStageOf(overId) ?? id;
    const arr = (byStage.get(to) ?? []).filter((x) => x.id !== id);
    const idx = arr.findIndex((x) => x.id === overId);
    persist(id, to, idx < 0 ? arr.length : idx);
  };

  if (query.isPending) {
    return (
      <div className="flex gap-3 overflow-x-auto">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-64 w-64 shrink-0" />
        ))}
      </div>
    );
  }
  if (query.isError)
    return (
      <ErrorState
        title="The board could not be loaded"
        message={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  if (!data) return null;
  if (stages.length === 0)
    return (
      <EmptyState
        title="This list has no stages"
        description="Add stages to the pipeline in its settings."
      />
    );

  const rotMs = (data.settings.rotDays || 14) * 86_400_000;
  const activeEntry = activeId ? data.entries.find((e) => e.id === activeId) : undefined;

  return (
    <div className="flex flex-col gap-2">
      {notice ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {notice}{' '}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2" role="list" aria-label="Pipeline stages">
          {stages.map((s) => {
            const items = byStage.get(s.id) ?? [];
            const limit = data.settings.wipLimits[s.id] ?? 0;
            const over = limit > 0 && items.length > limit;
            return (
              <StageColumn key={s.id} stage={s} count={items.length} limit={limit} over={over}>
                <SortableContext
                  items={items.map((e) => e.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {items.map((e, i) => {
                    const days = Math.floor(
                      (Date.now() - new Date(e.enteredStageAt).getTime()) / 86_400_000,
                    );
                    return (
                      <Card
                        key={e.id}
                        entry={e}
                        href={`/w/${slug}/records/${objectSlug}/${e.recordId}`}
                        rotting={Date.now() - new Date(e.enteredStageAt).getTime() > rotMs}
                        days={days}
                        stages={stages}
                        canMove={canMove}
                        onMoveToStage={(to) => persist(e.id, to, (byStage.get(to) ?? []).length)}
                        onNudge={(dir) => {
                          const j = i + dir;
                          if (j < 0 || j >= items.length) return;
                          persist(e.id, s.id, dir > 0 ? j + 0 : j);
                        }}
                      />
                    );
                  })}
                </SortableContext>
                {items.length === 0 ? (
                  <p className="px-2 py-3 text-center text-[var(--text-xs)] text-ink-muted">
                    Nothing here
                  </p>
                ) : null}
              </StageColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeEntry ? (
            <div className="rounded-[var(--radius-control)] border border-strong bg-raised px-3 py-2 text-[var(--text-sm)] shadow-[var(--elevation-2)]">
              {activeEntry.label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function StageColumn({
  stage,
  count,
  limit,
  over,
  children,
}: {
  stage: Stage;
  count: number;
  limit: number;
  over: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const headingId = useId();
  return (
    <section
      ref={setNodeRef}
      role="listitem"
      aria-labelledby={headingId}
      className={`flex w-64 shrink-0 flex-col rounded-[var(--radius-card)] border bg-card ${isOver ? 'border-link' : 'border-hairline'}`}
    >
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2">
        <h3 id={headingId} className="flex items-center gap-2 text-[var(--text-sm)] font-medium">
          {stage.color ? (
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ background: stage.color }}
            />
          ) : null}
          {stage.label}
        </h3>
        <span
          className={`tnum text-[var(--text-xs)] ${over ? 'text-critical' : 'text-ink-muted'}`}
          title={limit ? `WIP limit ${limit}` : undefined}
        >
          {count}
          {limit ? ` / ${limit}` : ''}
          {over ? <span className="sr-only"> over the limit</span> : null}
          {over ? <span aria-hidden> !</span> : null}
        </span>
      </header>
      <div className="flex min-h-24 flex-col gap-2 p-2">{children}</div>
    </section>
  );
}

function Card({
  entry,
  href,
  rotting,
  days,
  stages,
  canMove,
  onMoveToStage,
  onNudge,
}: {
  entry: Entry;
  href: string;
  rotting: boolean;
  days: number;
  stages: Stage[];
  canMove: boolean;
  onMoveToStage: (stage: string) => void;
  onNudge: (dir: 1 | -1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !canMove,
  });
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative rounded-[var(--radius-control)] border bg-raised p-2 text-[var(--text-sm)] ${isDragging ? 'opacity-40' : ''} ${rotting ? 'border-[var(--status-warning)]' : 'border-hairline'}`}
      aria-label={entry.label}
    >
      <div className="flex items-start gap-2">
        {canMove ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag ${entry.label}`}
            className="cursor-grab select-none px-1 text-ink-muted focus-visible:shadow-[var(--focus-ring)]"
          >
            ⋮⋮
          </button>
        ) : null}
        <a href={href} className="min-w-0 flex-1 truncate font-medium hover:underline">
          {entry.label}
        </a>
        {canMove ? (
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-controls={menuId}
            onClick={() => setMenu((m) => !m)}
            className="px-1 text-ink-muted focus-visible:shadow-[var(--focus-ring)]"
            aria-label={`Move ${entry.label}`}
          >
            ▾
          </button>
        ) : null}
      </div>
      <p className={`mt-1 text-[var(--text-xs)] ${rotting ? 'text-warning' : 'text-ink-muted'}`}>
        {rotting ? <StatusPill tone="warning">in stage {days}d</StatusPill> : `in stage ${days}d`}
      </p>
      {menu ? (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-8 z-20 min-w-40 rounded-[var(--radius-card)] border border-hairline bg-raised p-1 shadow-[var(--elevation-2)]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setMenu(false);
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1 text-left hover:bg-card"
            onClick={() => {
              onNudge(-1);
              setMenu(false);
            }}
          >
            Move up
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-2 py-1 text-left hover:bg-card"
            onClick={() => {
              onNudge(1);
              setMenu(false);
            }}
          >
            Move down
          </button>
          <div className="my-1 border-t border-hairline" />
          {stages
            .filter((s) => s.id !== entry.stage)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                className="block w-full rounded px-2 py-1 text-left hover:bg-card"
                onClick={() => {
                  onMoveToStage(s.id);
                  setMenu(false);
                }}
              >
                To {s.label}
              </button>
            ))}
        </div>
      ) : null}
    </article>
  );
}
