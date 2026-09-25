import type { RouterInputs, RouterOutputs } from '@/lib/trpc-types';

export type ListPage = RouterOutputs['conversation']['list'];
export type ListItem = ListPage['items'][number];
export type Thread = RouterOutputs['conversation']['get'];
export type Member = RouterOutputs['member']['list'][number];
export type CannedReply = RouterOutputs['cannedReply']['list'][number];
export type InboxViewRow = RouterOutputs['view']['list'][number];
export type ConnectionRow = RouterOutputs['connection']['list'][number];

type ListPlatform = NonNullable<Extract<RouterInputs['conversation']['list'], object>['platform']>;

export type InboxStatus = 'OPEN' | 'SNOOZED' | 'CLOSED' | 'SPAM';

export type Filters = {
  status: InboxStatus;
  platform?: string;
  /** 'anyone', 'me', 'unassigned' or a member's user id. */
  assignee: string;
  unread: boolean;
  sla?: 'breached' | 'due_soon';
  tag?: string;
  kind?: 'DM' | 'COMMENT_THREAD' | 'MENTION' | 'REVIEW' | 'EMAIL_THREAD';
  search: string;
  groupBy: 'none' | 'platform' | 'person';
};

export const DEFAULT_FILTERS: Filters = {
  status: 'OPEN',
  assignee: 'anyone',
  unread: false,
  search: '',
  groupBy: 'none',
};

/** The query input for a filter state (the server ignores `groupBy`). */
export function listInputFor(f: Filters) {
  return {
    status: f.status,
    ...(f.platform ? { platform: f.platform as ListPlatform } : {}),
    ...(f.assignee !== 'anyone' ? { assignee: f.assignee } : {}),
    ...(f.unread ? { unread: true } : {}),
    ...(f.sla ? { sla: f.sla } : {}),
    ...(f.tag ? { tag: f.tag } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.search.trim().length >= 2 ? { search: f.search.trim() } : {}),
    limit: 50,
  };
}

export function filtersFromJson(v: unknown): Filters {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Partial<Filters>;
  return {
    ...DEFAULT_FILTERS,
    ...o,
    search: typeof o.search === 'string' ? o.search : '',
    unread: Boolean(o.unread),
    groupBy: o.groupBy ?? 'none',
  };
}

export function whoIs(c: {
  identity: { displayName: string | null; handle: string | null; externalId: string } | null;
  person?: { label: string } | null;
}): string {
  if (c.person) return c.person.label;
  return (
    c.identity?.displayName ??
    (c.identity?.handle ? `@${c.identity.handle}` : (c.identity?.externalId ?? 'Unknown'))
  );
}

export const KIND_LABEL: Record<string, string> = {
  DM: 'Direct message',
  COMMENT_THREAD: 'Comment thread',
  MENTION: 'Mention',
  REVIEW: 'Review',
  EMAIL_THREAD: 'E-mail',
};

export function kindShort(kind: string): string {
  return kind === 'DM'
    ? 'DM'
    : kind === 'MENTION'
      ? 'mention'
      : kind === 'REVIEW'
        ? 'review'
        : kind === 'EMAIL_THREAD'
          ? 'email'
          : 'comment';
}

/** Human "3m ago" / "in 2h" for list rows and SLA chips. */
export function relative(from: Date | string, now = Date.now()): string {
  const ms = new Date(from).getTime() - now;
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000
      ? [Math.round(abs / 1000), 's']
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), 'm']
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), 'h']
          : [Math.round(abs / 86_400_000), 'd'];
  const text = `${unit[0]}${unit[1]}`;
  return ms < 0 ? `${text} ago` : `in ${text}`;
}

export type SlaState = { tone: 'none' | 'ok' | 'soon' | 'breached'; label: string };

export function slaState(dueAt: Date | string | null, now = Date.now()): SlaState {
  if (!dueAt) return { tone: 'none', label: '' };
  const ms = new Date(dueAt).getTime() - now;
  if (ms < 0) return { tone: 'breached', label: `SLA breached ${relative(dueAt, now)}` };
  if (ms < 30 * 60_000) return { tone: 'soon', label: `SLA due ${relative(dueAt, now)}` };
  return { tone: 'ok', label: `SLA due ${relative(dueAt, now)}` };
}

export function snoozePresets(now = new Date()): { label: string; until: Date }[] {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  return [
    { label: 'In 1 hour', until: new Date(now.getTime() + 3_600_000) },
    { label: 'In 3 hours', until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: 'Tomorrow 9:00', until: at(tomorrow, 9) },
    { label: 'Next Monday 9:00', until: at(monday, 9) },
  ];
}

export function memberName(m: { name: string | null; email: string } | null | undefined): string {
  return m ? (m.name ?? m.email) : 'Unassigned';
}

export function newNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
