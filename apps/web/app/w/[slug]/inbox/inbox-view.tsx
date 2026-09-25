'use client';

/**
 * The unified inbox (§12.2.A): three panes — list · thread · context — with the platform
 * tabs, filters, saved views and bulk triage in the list, SSE-driven refreshes, and the
 * keyboard model: j/k navigate, e archive (close/reopen), a assign, r reply, n note, s snooze,
 * Ctrl/⌘+Enter send, ⌘K palette (global). Every action is reachable without a mouse.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { useTRPC } from '@/lib/trpc-client';
import { useRealtime } from '@/lib/use-realtime';
import { ConversationList } from './conversation-list';
import { ContextSidebar } from './context-sidebar';
import {
  DEFAULT_FILTERS,
  listInputFor,
  type CannedReply,
  type ConnectionRow,
  type Filters,
  type InboxViewRow,
  type ListItem,
  type Member,
} from './inbox-shared';
import { ThreadPane, type ThreadHandle } from './thread';

export function InboxView({
  slug,
  selfId,
  initialSelectedId,
  connections,
  members,
  canned,
  views,
  canTriage,
  canNote,
  canWriteRecords,
}: {
  slug: string;
  selfId: string;
  initialSelectedId: string | null;
  connections: ConnectionRow[];
  members: Member[];
  canned: CannedReply[];
  views: InboxViewRow[];
  canTriage: boolean;
  canNote: boolean;
  canWriteRecords: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const threadRef = useRef<ThreadHandle>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const input = useMemo(() => listInputFor(filters), [filters]);
  const list = useInfiniteQuery({
    ...trpc.conversation.list.infiniteQueryOptions(input, {
      getNextPageParam: (p) => p.nextCursor ?? undefined,
    }),
    initialPageParam: null as string | null,
    refetchInterval: 30_000,
  });
  const viewsQuery = useQuery({
    ...trpc.view.list.queryOptions({ scope: 'inbox' }),
    initialData: views,
  });
  const items = useMemo<ListItem[]>(
    () => list.data?.pages.flatMap((p) => p.items) ?? [],
    [list.data],
  );
  const counts = list.data?.pages[0]?.counts ?? null;
  const platforms = useMemo(() => [...new Set(connections.map((c) => c.platform))], [connections]);

  // Realtime: refetch the list and the open thread when something changes.
  useRealtime(slug, ['conversation.changed', 'timeline.changed'], (e) => {
    if (e.topic === 'conversation.changed') {
      void qc.invalidateQueries({ queryKey: trpc.conversation.list.pathKey() });
      const ids = (e.payload['ids'] as string[] | undefined) ?? [];
      if (selectedId && ids.includes(selectedId)) {
        void qc.invalidateQueries({ queryKey: trpc.conversation.get.queryKey({ id: selectedId }) });
        void qc.invalidateQueries({
          queryKey: trpc.conversation.context.queryKey({ id: selectedId }),
        });
      }
    } else if (selectedId) {
      void qc.invalidateQueries({
        queryKey: trpc.conversation.context.queryKey({ id: selectedId }),
      });
    }
  });

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      router.replace(`/w/${slug}/inbox?c=${id}`, { scroll: false });
    },
    [router, slug],
  );

  // Keyboard model.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = items.findIndex((c) => c.id === selectedId);
      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          if (target?.getAttribute('role') === 'listbox' || e.key === 'j') {
            e.preventDefault();
            const next = items[Math.min(items.length - 1, idx + 1)];
            if (next) select(next.id);
          }
          break;
        }
        case 'k':
        case 'ArrowUp': {
          if (target?.getAttribute('role') === 'listbox' || e.key === 'k') {
            e.preventDefault();
            const prev = items[Math.max(0, idx - 1)];
            if (prev) select(prev.id);
          }
          break;
        }
        case 'e':
          e.preventDefault();
          threadRef.current?.close();
          break;
        case 'a':
          e.preventDefault();
          threadRef.current?.openAssign();
          break;
        case 'r':
          e.preventDefault();
          threadRef.current?.focusReply();
          break;
        case 'n':
          e.preventDefault();
          threadRef.current?.focusNote();
          break;
        case 's':
          e.preventDefault();
          threadRef.current?.openSnooze();
          break;
        case 'x':
          if (selectedId && canTriage) {
            e.preventDefault();
            setSelection((s) => {
              const n = new Set(s);
              if (n.has(selectedId)) n.delete(selectedId);
              else n.add(selectedId);
              return n;
            });
          }
          break;
        default:
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, selectedId, select, canTriage]);

  if (connections.length === 0) {
    return (
      <EmptyState
        title="Connect a platform to start receiving messages"
        description={
          <>
            Facebook Pages, Instagram and the mock platform are ready to connect from{' '}
            <Link className="text-link" href={`/w/${slug}/settings/integrations`}>
              Settings → Integrations
            </Link>
            .
          </>
        }
      />
    );
  }

  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(16rem,20rem)_minmax(24rem,1fr)_minmax(13rem,16rem)]"
      data-testid="inbox"
    >
      <ConversationList
        slug={slug}
        items={items}
        counts={counts}
        filters={filters}
        setFilters={(f) => {
          setFilters(f);
          setSelection(new Set());
        }}
        platforms={platforms}
        members={members}
        selectedId={selectedId}
        onSelect={select}
        selection={selection}
        setSelection={setSelection}
        hasNextPage={Boolean(list.hasNextPage)}
        isFetchingNextPage={list.isFetchingNextPage}
        fetchNextPage={() => void list.fetchNextPage()}
        isPending={list.isPending}
        canTriage={canTriage}
        views={viewsQuery.data}
        onBulkDone={() => void qc.invalidateQueries({ queryKey: trpc.conversation.pathKey() })}
        listRef={listRef}
      />
      <div className="min-h-0 min-w-0">
        {selectedId ? (
          <ThreadPane
            key={selectedId}
            ref={threadRef}
            id={selectedId}
            members={members}
            canned={canned}
            canTriage={canTriage}
            canNote={canNote}
            selfId={selfId}
          />
        ) : (
          <EmptyState
            title="Pick a conversation"
            description="j / k move through the list, Enter opens, r replies, a assigns, s snoozes, e closes."
          />
        )}
      </div>
      <div className="min-h-0 min-w-0 lg:col-start-2 xl:col-start-auto">
        {selectedId ? (
          <ContextSidebar
            key={selectedId}
            slug={slug}
            conversationId={selectedId}
            members={members}
            canTriage={canTriage}
            canWriteRecords={canWriteRecords}
            selfId={selfId}
          />
        ) : null}
      </div>
    </div>
  );
}
