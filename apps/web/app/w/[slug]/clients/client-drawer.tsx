'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  Flag,
  Globe,
  Mail,
  Megaphone,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Plus,
  ShieldCheck,
  SignpostBig,
  Target,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Avatar, CountryTag, StatusPill } from '@/components/client-pills';
import { DayLabel } from '@/components/day-label';
import { formatPhone, PRIORITY_TONE, STATUS_TONE, TONE_CLASS, toLocalInput } from '@/lib/clients';
import { useTRPC } from '@/lib/trpc-client';
import type { ClientsData, Patch, Row } from './clients-workspace';

const TABS = ['Overview', 'Activity', 'Notes', 'Files'] as const;
const noop = () => () => {};
type Tab = (typeof TABS)[number];

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-3 rounded-[9px] border border-hairline bg-raised p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[14.5px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoRow({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[31px] items-center gap-2.5 text-[13px]">
      <Icon aria-hidden size={15} className="shrink-0 text-ink-muted" />
      <span className="w-[100px] shrink-0 text-ink-secondary">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      onClick={() =>
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
      className="ml-auto shrink-0 rounded-[4px] p-1 text-ink-muted hover:text-ink"
    >
      <Copy aria-hidden size={13} />
    </button>
  );
}

/** A select styled as a coloured pill (status / priority) or a plain chip. */
function PillSelect({
  label,
  value,
  options,
  tone,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { id: string; label: string }[];
  tone: string;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  return (
    <span className={`relative inline-flex rounded-[6px] ${tone}`}>
      <select
        aria-label={label}
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-[27px] appearance-none rounded-[6px] bg-transparent pl-2.5 pr-7 text-[12px] font-semibold text-current focus:outline-none disabled:cursor-default"
      >
        <option value="" className="bg-raised text-ink">
          —
        </option>
        {options.map((o) => (
          <option key={o.id} value={o.id} className="bg-raised text-ink">
            {o.label}
          </option>
        ))}
      </select>
      {disabled ? null : (
        <ChevronDown
          aria-hidden
          size={13}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
        />
      )}
    </span>
  );
}

const editButton =
  'rounded-[5px] border border-strong bg-card px-2.5 py-1 text-[12px] text-ink-secondary hover:text-ink';

export function ClientDrawer({
  slug,
  row,
  data,
  canWrite,
  onPatch,
  onClose,
}: {
  slug: string;
  row: Row;
  data: ClientsData;
  canWrite: boolean;
  onPatch: (p: Patch) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('Overview');
  const [note, setNote] = useState('');
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const followUpInput = useRef<HTMLInputElement>(null);
  // datetime-local is wall-clock time: only fill it once we're in the viewer's time zone.
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  const timeline = useQuery(trpc.timeline.list.queryOptions({ recordId: row.id, limit: 50 }));
  const notes = useQuery({
    ...trpc.note.list.queryOptions({ recordId: row.id }),
    enabled: tab === 'Notes',
  });
  const addNote = useMutation(
    trpc.note.create.mutationOptions({
      onSuccess: () => {
        setNote('');
        void qc.invalidateQueries({ queryKey: trpc.note.list.queryKey({ recordId: row.id }) });
        void qc.invalidateQueries({ queryKey: trpc.timeline.list.pathKey() });
      },
    }),
  );

  const recordHref = `/w/${slug}/records/client/${row.id}`;
  const statusLabel = data.statuses.find((s) => s.id === row.status)?.label;
  const owner = data.agents.find((a) => a.id === row.ownerId);
  const digits = row.phone?.replace(/\D/g, '') ?? '';
  const latest = timeline.data?.items[0];

  const setTags = (tags: string[]) =>
    onPatch({ values: { tags: tags.length ? tags.join(', ') : null }, local: { tags } });

  const actionBtn =
    'flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-strong bg-raised px-3 text-[12.5px] text-ink hover:border-[#3a4b5e]';
  const disabledBtn = `${actionBtn} pointer-events-none opacity-40`;

  return (
    <aside
      aria-label={`Client: ${row.name}`}
      className="flex w-[380px] shrink-0 flex-col border-l border-hairline bg-card max-xl:absolute max-xl:bottom-0 max-xl:right-0 max-xl:top-14 max-xl:z-20 max-xl:shadow-[-15px_0_40px_rgba(0,0,0,0.5)]"
    >
      <div className="relative px-3.5 pb-3 pt-5">
        <button
          type="button"
          aria-label="Close client details"
          onClick={onClose}
          className="absolute right-3 top-2.5 rounded-[5px] p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X aria-hidden size={19} />
        </button>
        <div className="flex items-center gap-3 pr-6">
          <Avatar name={row.name} size={61} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[19px] font-bold">{row.name}</h2>
              <StatusPill id={row.status} label={statusLabel} />
            </div>
            <p className="mt-1.5 text-[13px] text-ink-secondary">
              <CountryTag country={row.country} phone={row.phone} full />
            </p>
            {row.campaign ? (
              <p className="mt-1 text-[12px] text-ink-secondary">
                Lead from <span className="text-link">{row.campaign}</span> campaign
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          {row.phone ? (
            <a
              href={`tel:${row.phone}`}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[6px] border border-[#fa7620] bg-[linear-gradient(#ff8628,#fa6508)] text-[12.5px] font-bold text-[#1a0d03] hover:brightness-110"
            >
              <Phone aria-hidden size={15} /> Call
            </a>
          ) : (
            <span aria-disabled="true" className={`${disabledBtn} flex-1`}>
              <Phone aria-hidden size={15} /> Call
            </span>
          )}
          {digits ? (
            <a
              href={`https://wa.me/${digits}`}
              target="_blank"
              rel="noopener noreferrer"
              className={actionBtn}
            >
              <MessageCircle aria-hidden size={15} /> WhatsApp
            </a>
          ) : (
            <span aria-disabled="true" className={disabledBtn}>
              <MessageCircle aria-hidden size={15} /> WhatsApp
            </span>
          )}
          {row.email ? (
            <a href={`mailto:${row.email}`} className={actionBtn}>
              <Mail aria-hidden size={15} /> Email
            </a>
          ) : (
            <span aria-disabled="true" className={disabledBtn}>
              <Mail aria-hidden size={15} /> Email
            </span>
          )}
          <details className="relative">
            <summary
              aria-label="More actions"
              className={`${actionBtn} w-9 cursor-pointer list-none px-0 [&::-webkit-details-marker]:hidden`}
            >
              <MoreHorizontal aria-hidden size={18} />
            </summary>
            <div className="absolute right-0 top-[calc(100%+6px)] z-20 flex w-48 flex-col rounded-[var(--radius-card)] border border-hairline bg-raised p-1 text-[13px] shadow-[var(--elevation-2)]">
              <Link href={recordHref} className="rounded-[5px] px-2.5 py-2 hover:bg-card">
                Open full record
              </Link>
              {canWrite ? (
                <Link
                  href={`${recordHref}/edit`}
                  className="rounded-[5px] px-2.5 py-2 hover:bg-card"
                >
                  Edit all fields
                </Link>
              ) : null}
            </div>
          </details>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Client details"
        className="flex border-b border-hairline px-3.5"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`client-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="client-tabpanel"
            onClick={() => setTab(t)}
            className={[
              'flex-1 border-b-2 px-1 py-3 text-[14px]',
              tab === t
                ? 'border-link font-medium text-ink'
                : 'border-transparent text-ink-secondary hover:text-ink',
            ].join(' ')}
          >
            {t}
          </button>
        ))}
      </div>

      <div
        id="client-tabpanel"
        role="tabpanel"
        aria-labelledby={`client-tab-${tab}`}
        className="min-h-0 flex-1 overflow-auto px-3 py-3"
      >
        {tab === 'Overview' ? (
          <>
            <Card
              title="Contact Information"
              action={
                canWrite ? (
                  <Link href={`${recordHref}/edit`} className={editButton}>
                    Edit
                  </Link>
                ) : undefined
              }
            >
              <InfoRow icon={Phone} label="Phone">
                {row.phone ? (
                  <>
                    <a
                      href={`tel:${row.phone}`}
                      className="tnum truncate text-[#5cbcff] hover:underline"
                    >
                      {formatPhone(row.phone)}
                    </a>
                    <CopyButton value={row.phone} label="phone number" />
                  </>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </InfoRow>
              <InfoRow icon={Mail} label="Email">
                {row.email ? (
                  <>
                    <a
                      href={`mailto:${row.email}`}
                      className="truncate text-[#5cbcff] hover:underline"
                    >
                      {row.email}
                    </a>
                    <CopyButton value={row.email} label="email address" />
                  </>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </InfoRow>
              <InfoRow icon={Globe} label="Country">
                <CountryTag country={row.country} phone={row.phone} full />
              </InfoRow>
              <InfoRow icon={Megaphone} label="Campaign">
                <span className="truncate">{row.campaign ?? '—'}</span>
              </InfoRow>
              <InfoRow icon={SignpostBig} label="Source">
                <span className="truncate">{row.source ?? '—'}</span>
              </InfoRow>
              <InfoRow icon={UserRound} label="Assigned Agent">
                {owner ? <Avatar name={owner.name ?? owner.email} size={24} /> : null}
                <span className="relative flex min-w-0 flex-1 items-center">
                  <select
                    aria-label="Assigned agent"
                    disabled={!canWrite}
                    value={row.ownerId ?? ''}
                    onChange={(e) =>
                      onPatch({
                        values: { owner: e.target.value ? [e.target.value] : null },
                        local: { ownerId: e.target.value || null },
                      })
                    }
                    className="w-full min-w-0 appearance-none truncate bg-transparent pr-6 text-[13px] text-ink focus:outline-none disabled:cursor-default"
                  >
                    <option value="" className="bg-raised">
                      Unassigned
                    </option>
                    {data.agents.map((a) => (
                      <option key={a.id} value={a.id} className="bg-raised">
                        {a.name ?? a.email}
                      </option>
                    ))}
                  </select>
                  {canWrite ? (
                    <ChevronDown
                      aria-hidden
                      size={14}
                      className="pointer-events-none absolute right-0 text-ink-secondary"
                    />
                  ) : null}
                </span>
              </InfoRow>
            </Card>

            <Card
              title="Sales Information"
              action={
                canWrite ? (
                  <Link href={`${recordHref}/edit`} className={editButton}>
                    Edit
                  </Link>
                ) : undefined
              }
            >
              <InfoRow icon={Target} label="Status">
                <PillSelect
                  label="Status"
                  value={row.status}
                  options={data.statuses}
                  tone={TONE_CLASS[(row.status && STATUS_TONE[row.status]) || 'gray']}
                  disabled={!canWrite}
                  onChange={(v) => onPatch({ values: { status: v }, local: { status: v } })}
                />
              </InfoRow>
              <InfoRow icon={Flag} label="Priority">
                <PillSelect
                  label="Priority"
                  value={row.priority}
                  options={data.priorities}
                  tone={TONE_CLASS[(row.priority && PRIORITY_TONE[row.priority]) || 'gray']}
                  disabled={!canWrite}
                  onChange={(v) => onPatch({ values: { priority: v }, local: { priority: v } })}
                />
              </InfoRow>
              <InfoRow icon={CalendarClock} label="Next Follow-up">
                <span className="relative inline-flex">
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => followUpInput.current?.showPicker?.()}
                    className="inline-flex items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-[13px] text-ink hover:bg-card disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <CalendarDays aria-hidden size={15} className="text-ink-secondary" />
                    <DayLabel iso={row.nextFollowUp} />
                    {canWrite ? (
                      <ChevronDown aria-hidden size={13} className="text-ink-secondary" />
                    ) : null}
                    <span className="sr-only">Change next follow-up</span>
                  </button>
                  <input
                    ref={followUpInput}
                    type="datetime-local"
                    tabIndex={-1}
                    aria-hidden
                    disabled={!canWrite}
                    value={hydrated ? toLocalInput(row.nextFollowUp) : ''}
                    onChange={(e) => {
                      const iso = e.target.value ? new Date(e.target.value).toISOString() : null;
                      onPatch({ values: { next_follow_up: iso }, local: { nextFollowUp: iso } });
                    }}
                    className="pointer-events-none absolute bottom-0 left-0 h-0 w-0 opacity-0 [color-scheme:dark]"
                  />
                </span>
                {canWrite && row.nextFollowUp ? (
                  <button
                    type="button"
                    aria-label="Clear next follow-up"
                    onClick={() =>
                      onPatch({ values: { next_follow_up: null }, local: { nextFollowUp: null } })
                    }
                    className="rounded-[4px] p-0.5 text-ink-muted hover:text-ink"
                  >
                    <X aria-hidden size={13} />
                  </button>
                ) : null}
                <Bell aria-hidden size={15} className="ml-auto shrink-0 text-ink-secondary" />
              </InfoRow>
              <InfoRow icon={Clock} label="Last Contact">
                <DayLabel iso={row.lastContact} />
                {canWrite ? (
                  <button
                    type="button"
                    onClick={() => {
                      const iso = new Date().toISOString();
                      onPatch({ values: { last_contact: iso }, local: { lastContact: iso } });
                    }}
                    className="ml-auto text-[12px] text-link hover:underline"
                  >
                    Log now
                  </button>
                ) : null}
              </InfoRow>
              <InfoRow icon={ShieldCheck} label="KYC Status">
                <PillSelect
                  label="KYC status"
                  value={row.kycStatus}
                  options={data.kycStatuses}
                  tone="bg-card text-ink"
                  disabled={!canWrite}
                  onChange={(v) => onPatch({ values: { kyc_status: v }, local: { kycStatus: v } })}
                />
              </InfoRow>
              {row.experience ? (
                <InfoRow icon={Target} label="Experience">
                  <span className="truncate">
                    {data.experiences.find((e) => e.id === row.experience)?.label ?? row.experience}
                  </span>
                </InfoRow>
              ) : null}
              {row.goals ? (
                <p className="mt-1 rounded-[6px] bg-card px-2.5 py-2 text-[12.5px] leading-relaxed text-ink-secondary">
                  <span className="font-medium text-ink">Goals: </span>
                  {row.goals}
                </p>
              ) : null}

              <div className="mb-2 mt-3.5 flex items-center justify-between text-[13px] text-ink-secondary">
                <span>Tags</span>
                {canWrite && tagDraft === null ? (
                  <button
                    type="button"
                    onClick={() => setTagDraft('')}
                    className="inline-flex items-center gap-0.5 text-link hover:underline"
                  >
                    <Plus aria-hidden size={13} /> Add tag
                  </button>
                ) : null}
              </div>
              <ul className="flex flex-wrap gap-1.5">
                {row.tags.map((t) => (
                  <li
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full border border-strong bg-card py-1 pl-2.5 pr-1.5 text-[11.5px] text-ink-secondary"
                  >
                    {t}
                    {canWrite ? (
                      <button
                        type="button"
                        aria-label={`Remove tag ${t}`}
                        onClick={() => setTags(row.tags.filter((x) => x !== t))}
                        className="rounded-full text-ink-muted hover:text-ink"
                      >
                        <X aria-hidden size={11} />
                      </button>
                    ) : null}
                  </li>
                ))}
                {tagDraft !== null ? (
                  <li>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const t = tagDraft.trim().replace(/,/g, ' ');
                        if (t && !row.tags.includes(t)) setTags([...row.tags, t]);
                        setTagDraft(null);
                      }}
                    >
                      <input
                        autoFocus
                        aria-label="New tag"
                        value={tagDraft}
                        maxLength={40}
                        onChange={(e) => setTagDraft(e.target.value)}
                        onBlur={() => setTagDraft(null)}
                        onKeyDown={(e) => e.key === 'Escape' && setTagDraft(null)}
                        placeholder="Tag name, Enter"
                        className="h-[26px] w-32 rounded-full border border-link bg-card px-2.5 text-[11.5px] text-ink focus:outline-none"
                      />
                    </form>
                  </li>
                ) : null}
                {row.tags.length === 0 && tagDraft === null ? (
                  <li className="text-[12px] text-ink-muted">No tags yet</li>
                ) : null}
              </ul>
            </Card>

            <Card
              title="Recent Activity"
              action={
                <button
                  type="button"
                  onClick={() => setTab('Activity')}
                  className="text-[12.5px] text-link hover:underline"
                >
                  View all
                </button>
              }
            >
              {latest ? (
                <div className="flex items-center gap-2.5 text-[13px]">
                  <span
                    aria-hidden
                    className="grid size-[34px] shrink-0 place-items-center rounded-full bg-[#0b493d] text-[#1ddd9b]"
                  >
                    <Phone size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{latest.summary}</p>
                    <p className="mt-0.5 text-[12px] text-ink-secondary">
                      <DayLabel iso={new Date(latest.occurredAt).toISOString()} />
                      {latest.actor?.kind === 'user' && latest.actor.name
                        ? ` by ${latest.actor.name}`
                        : ''}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-[12.5px] text-ink-muted">
                  {timeline.isLoading ? 'Loading…' : 'No activity recorded yet.'}
                </p>
              )}
            </Card>
          </>
        ) : null}

        {tab === 'Activity' ? (
          <Card title="Activity">
            {timeline.isLoading ? (
              <p className="text-[12.5px] text-ink-muted">Loading…</p>
            ) : timeline.data?.items.length ? (
              <ol className="flex flex-col gap-3">
                {timeline.data.items.map((e) => (
                  <li key={e.id} className="flex gap-2.5 text-[13px]">
                    <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-link" />
                    <div className="min-w-0">
                      <p>{e.summary}</p>
                      <p className="mt-0.5 text-[12px] text-ink-secondary">
                        <DayLabel iso={new Date(e.occurredAt).toISOString()} />
                        {e.actor?.kind === 'user' && e.actor.name ? ` · ${e.actor.name}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12.5px] text-ink-muted">
                Calls, emails, status changes and notes appear here as they happen.
              </p>
            )}
          </Card>
        ) : null}

        {tab === 'Notes' ? (
          <Card title="Notes">
            {canWrite ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (note.trim()) addNote.mutate({ recordId: row.id, body: note.trim() });
                }}
                className="mb-3 flex flex-col gap-2"
              >
                <textarea
                  aria-label="New note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Write a note about this client…"
                  rows={4}
                  className="w-full resize-y rounded-[6px] border border-strong bg-card p-2.5 text-[13px] text-ink placeholder:text-ink-muted focus:border-link focus:outline-none"
                />
                {addNote.error ? (
                  <p role="alert" className="text-[12px] text-critical">
                    {addNote.error.message}
                  </p>
                ) : null}
                <button
                  type="submit"
                  disabled={!note.trim() || addNote.isPending}
                  className="self-end rounded-[6px] bg-link px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-inverse disabled:opacity-50"
                >
                  {addNote.isPending ? 'Saving…' : 'Save note'}
                </button>
              </form>
            ) : null}
            {notes.isLoading ? (
              <p className="text-[12.5px] text-ink-muted">Loading…</p>
            ) : notes.data?.length ? (
              <ul className="flex flex-col gap-2">
                {notes.data.map((n) => (
                  <li key={n.id} className="rounded-[6px] bg-card px-3 py-2 text-[13px]">
                    <p className="whitespace-pre-wrap">{n.body}</p>
                    <p className="mt-1 text-[11.5px] text-ink-muted">
                      {n.author?.name ?? n.author?.email ?? 'Someone'} ·{' '}
                      <DayLabel iso={new Date(n.createdAt).toISOString()} />
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-muted">No notes yet.</p>
            )}
          </Card>
        ) : null}

        {tab === 'Files' ? (
          <Card title="Files">
            <div className="flex items-start gap-2.5 text-[12.5px] text-ink-secondary">
              <FileText aria-hidden size={16} className="mt-0.5 shrink-0 text-ink-muted" />
              <p>
                File attachments aren&apos;t available yet. Upload KYC documents and contracts here
                once document storage is connected.
              </p>
            </div>
          </Card>
        ) : null}
      </div>
    </aside>
  );
}
