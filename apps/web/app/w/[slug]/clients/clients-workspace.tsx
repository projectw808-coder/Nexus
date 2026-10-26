'use client';

import { useMutation } from '@tanstack/react-query';
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Handshake,
  MoreHorizontal,
  Plus,
  Search,
  UserRoundPlus,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar, CountryTag, PriorityPill, StatusPill } from '@/components/client-pills';
import { DayLabel } from '@/components/day-label';
import { formatPhone, isDue } from '@/lib/clients';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';
import { AddClientDialog } from './add-client-dialog';
import { ClientDrawer } from './client-drawer';

export type ClientsData = RouterOutputs['clientWorkspace']['all'];
export type Row = ClientsData['rows'][number];
export type Patch = { values: Record<string, unknown>; local: Partial<Row> };
type EditMeta = { pending: number; confirmedAt: string | null };

const DAY = 86_400_000;
const PER_PAGE = [10, 25, 50, 100];
const DATE_RANGES = [
  { id: '', label: 'Date' },
  { id: 'today', label: 'Added today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
] as const;
const VIEWS = [
  { id: 'all', label: 'All clients' },
  { id: 'mine', label: 'My clients' },
  { id: 'due', label: 'Follow-ups due' },
  { id: 'new', label: 'New leads' },
  { id: 'unassigned', label: 'Unassigned' },
] as const;

const CONTROL =
  'h-[38px] rounded-[6px] border border-strong bg-raised text-[13.5px] text-ink hover:border-[#3a4b5e] focus:border-link focus:outline-none';

/** A native select that looks like the design's dropdown chips; keeps native keyboard/a11y. */
function FilterSelect({
  label,
  value,
  onChange,
  children,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${CONTROL} w-full appearance-none truncate pl-3 pr-8 ${value ? 'border-link/60' : ''}`}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        size={15}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
    </span>
  );
}

function Spark({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <span aria-hidden className="flex h-[38px] items-end gap-[3px]" style={{ color }}>
      {values.map((v, i) => (
        <i
          key={i}
          className="block w-[2.5px] rounded-full bg-current opacity-85"
          style={{ height: `${Math.max(3, Math.round((v / max) * 38))}px` }}
        />
      ))}
    </span>
  );
}

function Stat({
  icon: Icon,
  tile,
  color,
  value,
  label,
  trend,
  spark,
}: {
  icon: LucideIcon;
  tile: string;
  color: string;
  value: number;
  label: string;
  trend?: string | null;
  spark: number[];
}) {
  return (
    <div className="flex h-[84px] min-w-0 items-center gap-4 rounded-[9px] border border-hairline bg-[linear-gradient(115deg,var(--surface-raised),var(--surface-card))] p-3.5">
      <span
        aria-hidden
        className={`grid size-[51px] shrink-0 place-items-center rounded-[12px] ${tile}`}
        style={{ color }}
      >
        <Icon size={27} />
      </span>
      <div className="min-w-0">
        <p className="tnum text-[23px] font-bold leading-tight">{value.toLocaleString('en-GB')}</p>
        <p className="truncate text-[13.5px] text-ink-secondary">{label}</p>
      </div>
      <div className="ml-auto flex h-full flex-col items-end justify-between">
        {trend ? (
          <span className="text-[12px] font-semibold text-[#17d69b]">{trend}</span>
        ) : (
          <span />
        )}
        <Spark values={spark} color={color} />
      </div>
    </div>
  );
}

/** Daily counts for the last `days` days (oldest first), from ISO timestamps. */
function perDay(isos: (string | null)[], days: number, forward = false): number[] {
  const out = Array<number>(days).fill(0);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  for (const iso of isos) {
    if (!iso) continue;
    const t = new Date(iso).getTime();
    const idx = forward
      ? Math.floor((t - start) / DAY)
      : days - 1 - Math.floor((start + DAY - 1 - t) / DAY);
    if (idx >= 0 && idx < days) out[idx]! += 1;
  }
  return out;
}

function pageList(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const head = page <= 4 ? [1, 2, 3, 4, 5] : [1, '…' as const, page - 1, page, page + 1];
  const tail = page >= pages - 3 ? [pages - 4, pages - 3, pages - 2, pages - 1, pages] : null;
  if (tail) return [1, '…', ...tail.filter((p) => p > 1)];
  return [...head, '…', pages];
}

export function ClientsWorkspace({
  slug,
  data,
  meId,
  canWrite,
  initialClientId,
  initialFilters,
}: {
  slug: string;
  data: ClientsData;
  meId: string;
  canWrite: boolean;
  initialClientId: string | null;
  initialFilters: { campaign: string; agent: string; status: string; view: string };
}) {
  const trpc = useTRPC();
  const router = useRouter();
  // Server time of the data: keeps date maths pure and identical on server and client.
  const now = data.now;

  // Optimistic edits sit on top of the server rows. A refresh can land carrying data read
  // before an edit saved, so an edit is only dropped once the server's own copy of that row is
  // at least as new as the save it confirmed (both timestamps from the server's clock).
  const [baseData, setBaseData] = useState(data);
  const [overrides, setOverrides] = useState<Record<string, Partial<Row>>>({});
  const [meta, setMeta] = useState<Record<string, EditMeta>>({});
  if (baseData !== data) {
    setBaseData(data);
    const byId = new Map(data.rows.map((r) => [r.id, r]));
    setOverrides((o) => {
      const next: Record<string, Partial<Row>> = {};
      for (const [id, edit] of Object.entries(o)) {
        const row = byId.get(id);
        const m = meta[id];
        if (row && m && (m.pending > 0 || (m.confirmedAt && row.updatedAt < m.confirmedAt)))
          next[id] = edit;
      }
      return next;
    });
  }
  const rows = useMemo(
    () => data.rows.map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
    [data.rows, overrides],
  );

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(initialFilters.status);
  const [agent, setAgent] = useState(initialFilters.agent);
  const [campaign, setCampaign] = useState(initialFilters.campaign);
  const [range, setRange] = useState('');
  const [priority, setPriority] = useState('');
  const [view, setView] = useState(
    VIEWS.some((v) => v.id === initialFilters.view) ? initialFilters.view : 'all',
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(
    initialClientId ?? data.rows[0]?.id ?? null,
  );
  const [panelOpen, setPanelOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const statusLabel = useMemo(
    () => new Map(data.statuses.map((s) => [s.id, s.label])),
    [data.statuses],
  );
  const priorityLabel = useMemo(
    () => new Map(data.priorities.map((p) => [p.id, p.label])),
    [data.priorities],
  );
  const agentName = useMemo(
    () => new Map(data.agents.map((a) => [a.id, a.name ?? a.email])),
    [data.agents],
  );
  const campaigns = useMemo(
    () =>
      [...new Set(rows.map((r) => r.campaign).filter((c): c is string => !!c))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  );

  const update = useMutation(trpc.record.update.mutationOptions());
  // One save at a time per client: two quick edits to the same field (say, tags) must reach the
  // server in the order they were made, or the older value would win.
  const queues = useRef(new Map<string, Promise<unknown>>());

  const patch = (id: string, p: Patch) => {
    setOverrides((o) => ({ ...o, [id]: { ...o[id], ...p.local } }));
    setMeta((m) => ({
      ...m,
      [id]: { pending: (m[id]?.pending ?? 0) + 1, confirmedAt: m[id]?.confirmedAt ?? null },
    }));
    const settle = (confirmedAt: string | null) =>
      setMeta((m) => ({
        ...m,
        [id]: {
          pending: Math.max(0, (m[id]?.pending ?? 1) - 1),
          confirmedAt: confirmedAt ?? m[id]?.confirmedAt ?? null,
        },
      }));
    const run = (queues.current.get(id) ?? Promise.resolve())
      .then(() => update.mutateAsync({ id, values: p.values }))
      .then(
        (saved) => {
          settle(new Date(saved.updatedAt).toISOString());
          router.refresh();
        },
        (e: unknown) => {
          settle(null);
          setOverrides((o) => {
            const next = { ...o };
            delete next[id];
            return next;
          });
          setNotice(e instanceof Error ? e.message : 'That change could not be saved.');
        },
      );
    queues.current.set(id, run);
  };

  // Closing or reloading the tab mid-save would drop queued edits: ask first.
  const saving = Object.values(meta).some((m) => m.pending > 0);
  useEffect(() => {
    if (!saving) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saving]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const since =
      range === 'today'
        ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
        : range === '7d'
          ? now - 7 * DAY
          : range === '30d'
            ? now - 30 * DAY
            : range === '90d'
              ? now - 90 * DAY
              : null;
    const out = rows.filter((r) => {
      if (q) {
        const owner = r.ownerId ? (agentName.get(r.ownerId) ?? '') : '';
        const hay = [r.name, r.email, r.phone, r.phone?.replace(/\D/g, ''), owner, r.campaign]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q) && !hay.includes(q.replace(/\D/g, '') || '\u0000')) return false;
      }
      if (status && r.status !== status) return false;
      if (agent === 'unassigned' ? r.ownerId : agent && r.ownerId !== agent) return false;
      if (campaign && r.campaign !== campaign) return false;
      if (priority && r.priority !== priority) return false;
      if (since !== null && new Date(r.createdAt).getTime() < since) return false;
      if (view === 'mine' && r.ownerId !== meId) return false;
      if (view === 'due' && !isDue(r.nextFollowUp)) return false;
      if (view === 'new' && r.status !== 'new') return false;
      if (view === 'unassigned' && r.ownerId) return false;
      return true;
    });
    if (sortDir)
      out.sort((a, b) =>
        sortDir === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
      );
    return out;
  }, [rows, query, status, agent, campaign, priority, range, view, sortDir, agentName, meId, now]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * perPage, current * perPage);
  const anyFilter = !!(query || status || agent || campaign || range || priority || view !== 'all');
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const resetPage =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const select = (id: string) => {
    setSelectedId(id);
    setPanelOpen(true);
    window.history.replaceState(null, '', `?client=${id}`);
  };

  // ── KPIs (live, from the same rows the table shows before filtering) ──────────
  const kpi = useMemo(() => {
    const recent = rows.filter((r) => now - new Date(r.createdAt).getTime() < 30 * DAY).length;
    const before = rows.length - recent;
    return {
      total: rows.length,
      totalTrend: before > 0 && recent > 0 ? `↑ ${Math.round((recent / before) * 100)}%` : null,
      newLeads: rows.filter((r) => r.status === 'new').length,
      due: rows.filter((r) => isDue(r.nextFollowUp)).length,
      active: rows.filter((r) => r.status === 'active_client').length,
      sparkTotal: perDay(
        rows.map((r) => r.createdAt),
        10,
      ),
      sparkNew: perDay(
        rows.filter((r) => r.status === 'new').map((r) => r.createdAt),
        10,
      ),
      sparkDue: perDay(
        rows.map((r) => r.nextFollowUp),
        10,
        true,
      ),
      sparkActive: perDay(
        rows.filter((r) => r.status === 'active_client').map((r) => r.updatedAt),
        10,
      ),
    };
  }, [rows, now]);

  const allVisibleChecked = visible.length > 0 && visible.every((r) => checked.has(r.id));

  const bulk = (values: Record<string, unknown>, local: Partial<Row>) => {
    for (const id of checked) patch(id, { values, local });
    setChecked(new Set());
  };

  return (
    <div className="-m-6 flex h-[calc(100dvh-3.5rem)] min-h-0">
      <section
        aria-labelledby="clients-title"
        className="flex min-w-0 flex-1 flex-col overflow-auto px-[22px] pt-[17px]"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1
              id="clients-title"
              className="text-[28px] font-bold leading-tight tracking-[-0.7px]"
            >
              Clients
            </h1>
            <p className="mt-1 text-[14px] text-ink-secondary">
              Manage leads, assignments, and customer relationships.
              <span role="status" className="ml-2 text-[12.5px] text-link">
                {saving ? 'Saving…' : ''}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2.5">
            {canWrite ? (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex h-[41px] items-center gap-2 rounded-[7px] border border-[#fa7620] bg-[linear-gradient(#ff8628,#fa6508)] px-4 text-[14px] font-bold text-[#1a0d03] hover:brightness-110"
              >
                <Plus aria-hidden size={18} strokeWidth={2.5} /> Add Client
              </button>
            ) : null}
            <details className="relative">
              <summary
                aria-label="More client actions"
                className="grid size-[41px] cursor-pointer list-none place-items-center rounded-[7px] border border-strong bg-raised text-ink-secondary hover:text-ink [&::-webkit-details-marker]:hidden"
              >
                <MoreHorizontal aria-hidden size={20} className="rotate-90" />
              </summary>
              <div className="absolute right-0 top-[calc(100%+6px)] z-20 flex w-52 flex-col rounded-[var(--radius-card)] border border-hairline bg-raised p-1 text-[13px] shadow-[var(--elevation-2)]">
                {canWrite ? (
                  <Link
                    href={`/w/${slug}/records/client/import`}
                    className="rounded-[5px] px-2.5 py-2 hover:bg-card"
                  >
                    Import CSV
                  </Link>
                ) : null}
                <Link
                  href={`/w/${slug}/records/client/export`}
                  prefetch={false}
                  className="rounded-[5px] px-2.5 py-2 hover:bg-card"
                >
                  Export CSV
                </Link>
                <Link
                  href={`/w/${slug}/records/client`}
                  className="rounded-[5px] px-2.5 py-2 hover:bg-card"
                >
                  Open table view
                </Link>
                <Link
                  href={`/w/${slug}/settings/objects`}
                  className="rounded-[5px] px-2.5 py-2 hover:bg-card"
                >
                  Edit fields & statuses
                </Link>
              </div>
            </details>
          </div>
        </div>

        <div className="mb-[18px] grid grid-cols-2 gap-3 2xl:grid-cols-4">
          <Stat
            icon={Users}
            tile="bg-[#4c2919]"
            color="#ff7d17"
            value={kpi.total}
            label="Total Clients"
            trend={kpi.totalTrend}
            spark={kpi.sparkTotal}
          />
          <Stat
            icon={UserRoundPlus}
            tile="bg-[#133a7a]"
            color="#49a9ff"
            value={kpi.newLeads}
            label="New Leads"
            spark={kpi.sparkNew}
          />
          <Stat
            icon={Clock}
            tile="bg-[#543b0b]"
            color="#ffbd13"
            value={kpi.due}
            label="Follow-ups Due"
            spark={kpi.sparkDue}
          />
          <Stat
            icon={Handshake}
            tile="bg-[#0b493d]"
            color="#0fe6a0"
            value={kpi.active}
            label="Active Clients"
            spark={kpi.sparkActive}
          />
        </div>

        <div
          role="toolbar"
          aria-label="Filter clients"
          className="mb-2.5 flex flex-wrap items-center gap-2"
        >
          <div className={`${CONTROL} flex w-[230px] shrink-0 items-center gap-2 px-3`}>
            <Search aria-hidden size={18} className="shrink-0 text-ink-secondary" />
            <input
              type="search"
              aria-label="Search clients"
              placeholder="Search clients..."
              value={query}
              onChange={(e) => resetPage(setQuery)(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-ink-muted focus:outline-none"
            />
          </div>
          <FilterSelect
            className="w-[100px]"
            label="Status"
            value={status}
            onChange={resetPage(setStatus)}
          >
            <option value="">Status</option>
            {data.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            className="w-[96px]"
            label="Agent"
            value={agent}
            onChange={resetPage(setAgent)}
          >
            <option value="">Agent</option>
            <option value="unassigned">Unassigned</option>
            {data.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.email}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            className="w-[122px]"
            label="Campaign"
            value={campaign}
            onChange={resetPage(setCampaign)}
          >
            <option value="">Campaign</option>
            {campaigns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            className="w-[90px]"
            label="Date added"
            value={range}
            onChange={resetPage(setRange)}
          >
            {DATE_RANGES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            className="w-[100px]"
            label="Priority"
            value={priority}
            onChange={resetPage(setPriority)}
          >
            <option value="">Priority</option>
            {data.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </FilterSelect>
          <button
            type="button"
            disabled={!anyFilter}
            onClick={() => {
              setQuery('');
              setStatus('');
              setAgent('');
              setCampaign('');
              setRange('');
              setPriority('');
              setView('all');
              setPage(1);
            }}
            className="shrink-0 px-2 text-[13.5px] text-[#4aaeff] hover:underline disabled:cursor-default disabled:opacity-50 disabled:hover:no-underline"
          >
            Clear
          </button>
          <span className="flex-1" />
          <FilterSelect
            className="w-[102px]"
            label="Saved view"
            value={view}
            onChange={resetPage(setView)}
          >
            {VIEWS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id === 'all' ? 'Views' : v.label}
              </option>
            ))}
          </FilterSelect>
          <details className="relative shrink-0">
            <summary
              aria-label="Table options"
              className={`${CONTROL} grid w-[38px] cursor-pointer list-none place-items-center text-ink-secondary [&::-webkit-details-marker]:hidden`}
            >
              <MoreHorizontal aria-hidden size={18} />
            </summary>
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 flex w-52 flex-col rounded-[var(--radius-card)] border border-hairline bg-raised p-1 text-[13px] shadow-[var(--elevation-2)]">
              <Link
                href={`/w/${slug}/records/client`}
                className="rounded-[5px] px-2.5 py-2 hover:bg-card"
              >
                Columns & saved views
              </Link>
              <Link
                href={`/w/${slug}/records/client/export`}
                prefetch={false}
                className="rounded-[5px] px-2.5 py-2 hover:bg-card"
              >
                Export CSV
              </Link>
            </div>
          </details>
        </div>

        {checked.size > 0 && canWrite ? (
          <div className="mb-2.5 flex items-center gap-3 rounded-[8px] border border-link/40 bg-[#ff791e14] px-3 py-2 text-[13px]">
            <span className="font-semibold">{checked.size} selected</span>
            <FilterSelect
              label="Set status for selected"
              value=""
              onChange={(v) => v && bulk({ status: v }, { status: v })}
            >
              <option value="">Set status…</option>
              {data.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Assign selected to"
              value=""
              onChange={(v) =>
                v &&
                bulk({ owner: v === 'none' ? null : [v] }, { ownerId: v === 'none' ? null : v })
              }
            >
              <option value="">Assign to…</option>
              <option value="none">Unassigned</option>
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.email}
                </option>
              ))}
            </FilterSelect>
            <button
              type="button"
              onClick={() => setChecked(new Set())}
              className="ml-auto inline-flex items-center gap-1 text-ink-secondary hover:text-ink"
            >
              <X aria-hidden size={14} /> Clear selection
            </button>
          </div>
        ) : null}

        <div className="min-h-0 overflow-auto rounded-[8px] border border-hairline bg-card">
          <table className="w-full min-w-[1060px] table-fixed border-collapse whitespace-nowrap text-[12px]">
            <colgroup>
              {[2.8, 14.7, 12.2, 12.6, 11.4, 13.8, 10.3, 10.3, 8.6, 3.3].map((w, i) => (
                <col key={i} style={{ width: `${w}%` }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-[1] bg-raised text-ink-secondary">
              <tr className="h-[38px] border-b border-hairline text-left">
                <th className="w-9 pl-2.5 font-medium">
                  <input
                    type="checkbox"
                    aria-label="Select all clients on this page"
                    checked={allVisibleChecked}
                    onChange={(e) =>
                      setChecked((c) => {
                        const next = new Set(c);
                        for (const r of visible) {
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                        }
                        return next;
                      })
                    }
                    className="size-4 accent-[#ff791e]"
                  />
                </th>
                <th
                  className="px-[7px] font-medium"
                  aria-sort={
                    sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                    className="inline-flex items-center gap-1.5 hover:text-ink"
                  >
                    Client <ArrowUpDown aria-hidden size={13} />
                  </button>
                </th>
                {[
                  'Phone',
                  'Email',
                  'Status',
                  'Agent',
                  'Last Contact',
                  'Next Follow-up',
                  'Priority',
                ].map((h) => (
                  <th key={h} className="px-[7px] font-medium">
                    {h}
                  </th>
                ))}
                <th className="px-1">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const isSel = panelOpen && r.id === selectedId;
                const owner = r.ownerId ? agentName.get(r.ownerId) : null;
                const due = isDue(r.nextFollowUp);
                return (
                  <tr
                    key={r.id}
                    onClick={() => select(r.id)}
                    className={[
                      'h-[43px] cursor-pointer border-b border-hairline text-ink last:border-b-0',
                      isSel
                        ? 'bg-[#182736] shadow-[inset_3px_0_0_var(--ink-link)]'
                        : 'hover:bg-raised',
                    ].join(' ')}
                  >
                    <td className="pl-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.name}`}
                        checked={checked.has(r.id)}
                        onChange={(e) =>
                          setChecked((c) => {
                            const next = new Set(c);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            return next;
                          })
                        }
                        className="size-4 accent-[#ff791e]"
                      />
                    </td>
                    <td className="px-[7px]">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.name} size={29} />
                        <span className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              select(r.id);
                            }}
                            aria-current={isSel ? 'true' : undefined}
                            className="block max-w-full truncate text-left text-[13px] font-semibold hover:text-link"
                          >
                            {r.name}
                          </button>
                          <span className="mt-0.5 block text-[11.5px] text-ink-secondary">
                            <CountryTag country={r.country} phone={r.phone} />
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="tnum truncate px-[7px]">{formatPhone(r.phone)}</td>
                    <td className="truncate px-[7px]">{r.email ?? '—'}</td>
                    <td className="px-[7px]">
                      <StatusPill
                        id={r.status}
                        label={r.status ? statusLabel.get(r.status) : undefined}
                      />
                    </td>
                    <td className="px-[7px]">
                      <span className="flex min-w-0 items-center gap-2">
                        {owner ? (
                          <Avatar name={owner} size={24} />
                        ) : (
                          <span
                            aria-hidden
                            className="grid size-[25px] place-items-center rounded-full border border-strong text-[11px] text-ink-muted"
                          >
                            ?
                          </span>
                        )}
                        <span className={`min-w-0 truncate ${owner ? '' : 'text-ink-secondary'}`}>
                          {owner ?? 'Unassigned'}
                        </span>
                      </span>
                    </td>
                    <td className="truncate px-[7px]">
                      <DayLabel iso={r.lastContact} />
                    </td>
                    <td className={`truncate px-[7px] ${due ? 'font-medium text-[#ffb13e]' : ''}`}>
                      <DayLabel iso={r.nextFollowUp} />
                    </td>
                    <td className="px-[7px]">
                      <PriorityPill
                        id={r.priority}
                        label={r.priority ? priorityLabel.get(r.priority) : undefined}
                      />
                    </td>
                    <td className="px-1" onClick={(e) => e.stopPropagation()}>
                      <Link
                        href={`/w/${slug}/records/client/${r.id}`}
                        aria-label={`Open the full record for ${r.name}`}
                        className="grid size-7 place-items-center rounded-[5px] text-ink-secondary hover:bg-raised hover:text-ink"
                      >
                        <MoreHorizontal aria-hidden size={17} />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 ? (
            <div className="px-6 py-12 text-center text-[13.5px] text-ink-secondary">
              {rows.length === 0 ? (
                <>
                  No clients yet.{' '}
                  {canWrite ? (
                    <button
                      type="button"
                      onClick={() => setAdding(true)}
                      className="text-link hover:underline"
                    >
                      Add your first client
                    </button>
                  ) : null}
                </>
              ) : (
                'No clients match these filters.'
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-[13.5px] text-ink-secondary">
          <span className="tnum">
            {filtered.length === 0
              ? `0 of ${rows.length.toLocaleString('en-GB')} clients`
              : `${(current - 1) * perPage + 1}–${Math.min(current * perPage, filtered.length)} of ${filtered.length.toLocaleString('en-GB')} clients`}
            {data.truncated ? ' (showing the first 5,000)' : ''}
          </span>
          <nav aria-label="Pagination" className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
              className="grid size-[30px] place-items-center rounded-[5px] border border-strong bg-raised text-ink disabled:opacity-40"
            >
              <ChevronLeft aria-hidden size={16} />
            </button>
            {pageList(current, pages).map((p, i) =>
              p === '…' ? (
                <span key={`gap-${i}`} className="px-1.5">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  aria-current={p === current ? 'page' : undefined}
                  onClick={() => setPage(p)}
                  className={[
                    'tnum h-[30px] min-w-[30px] rounded-[5px] border px-2 text-[13px]',
                    p === current
                      ? 'border-link bg-link font-semibold text-ink-inverse'
                      : 'border-strong bg-raised text-ink hover:border-[#3a4b5e]',
                  ].join(' ')}
                >
                  {p}
                </button>
              ),
            )}
            <button
              type="button"
              aria-label="Next page"
              disabled={current >= pages}
              onClick={() => setPage(current + 1)}
              className="grid size-[30px] place-items-center rounded-[5px] border border-strong bg-raised text-ink disabled:opacity-40"
            >
              <ChevronRight aria-hidden size={16} />
            </button>
          </nav>
          <label className="flex items-center gap-2">
            Rows per page:
            <FilterSelect
              className="w-[70px]"
              label="Rows per page"
              value={String(perPage)}
              onChange={(v) => {
                setPerPage(Number(v));
                setPage(1);
              }}
            >
              {PER_PAGE.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </FilterSelect>
          </label>
        </div>
      </section>

      {panelOpen && selected ? (
        <ClientDrawer
          key={selected.id}
          slug={slug}
          row={selected}
          data={data}
          canWrite={canWrite}
          onPatch={(p) => patch(selected.id, p)}
          onClose={() => {
            setPanelOpen(false);
            window.history.replaceState(null, '', window.location.pathname);
          }}
        />
      ) : null}

      {adding ? (
        <AddClientDialog
          data={data}
          meId={meId}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            setSelectedId(id);
            setPanelOpen(true);
            // A real navigation, not replaceState + refresh: replaceState cancels a pending
            // refresh, and the new row only exists in the refetched data.
            router.replace(`?client=${id}`, { scroll: false });
          }}
        />
      ) : null}

      {notice ? (
        <div
          role="alert"
          className="fixed bottom-5 right-5 z-40 flex max-w-sm items-start gap-3 rounded-[7px] border border-link bg-raised px-4 py-3 text-[13px] shadow-[var(--elevation-2)]"
        >
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="text-ink-secondary hover:text-ink"
          >
            <X aria-hidden size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
