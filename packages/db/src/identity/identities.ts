/**
 * Identity rows (spec §6.3, §8.7): one handle/address on one platform, keyed on the platform's
 * stable id — never the handle. Handles change; the history lives in `raw._handleHistory` and
 * a handle change is a timeline event, because it is a genuinely useful signal.
 */
import type { Platform } from '../generated/prisma/enums.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { TenantDb } from '../scoped.ts';
import { emitTimelineEvent } from './timeline.ts';

export type IdentityUpsertInput = {
  workspaceId: string;
  platform: Platform;
  externalId: string;
  seenAt: Date;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  /** The platform payload; stored under `raw` with the reserved `_canonical`/`_handleHistory` keys. */
  raw?: unknown;
  /** Canonical extras the scorer uses (bio, locale, timezone, platform-provided links). */
  canonical?: {
    bio?: string | null;
    locale?: string | null;
    timezone?: string | null;
    companyExternalId?: string | null;
    linked?: { platform: Platform; externalId: string }[];
  };
  connectionId?: string | null;
};

export type IdentityUpsertResult = {
  id: string;
  created: boolean;
  personRecordId: string | null;
  handleChange: { from: string; to: string } | null;
  /** True when a signal the resolver cares about (email, phone, handle, name, bio) changed. */
  signalsChanged: boolean;
};

type RawBag = Record<string, unknown> & {
  _handleHistory?: { handle: string; from: string; to: string | null }[];
  _canonical?: Record<string, unknown>;
};

function bagOf(raw: unknown): RawBag {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? { ...(raw as RawBag) }
    : {};
}

/** Create or refresh an identity. Never clears a known value with an absent one. */
export async function upsertIdentity(
  db: TenantDb,
  input: IdentityUpsertInput,
): Promise<IdentityUpsertResult> {
  const existing = await db.identity.findFirst({
    where: { platform: input.platform, externalId: input.externalId },
  });
  const canonical = input.canonical
    ? Object.fromEntries(Object.entries(input.canonical).filter(([, v]) => v != null))
    : null;
  if (!existing) {
    const raw = bagOf(input.raw);
    if (canonical) raw._canonical = canonical;
    if (input.handle)
      raw._handleHistory = [{ handle: input.handle, from: input.seenAt.toISOString(), to: null }];
    const created = await db.identity.create({
      data: {
        workspaceId: input.workspaceId,
        platform: input.platform,
        externalId: input.externalId,
        handle: input.handle ?? null,
        displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        profileUrl: input.profileUrl ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        raw: raw as Prisma.InputJsonValue,
        firstSeenAt: input.seenAt,
        lastSeenAt: input.seenAt,
      },
      select: { id: true },
    });
    return {
      id: created.id,
      created: true,
      personRecordId: null,
      handleChange: null,
      signalsChanged: true,
    };
  }

  const data: Prisma.IdentityUpdateInput = {};
  let signalsChanged = false;
  const set = <K extends 'handle' | 'displayName' | 'avatarUrl' | 'profileUrl' | 'email' | 'phone'>(
    key: K,
    value: string | null | undefined,
    signal: boolean,
  ) => {
    if (value && value !== existing[key]) {
      data[key] = value;
      if (signal) signalsChanged = true;
    }
  };
  set('displayName', input.displayName, true);
  set('avatarUrl', input.avatarUrl, false);
  set('profileUrl', input.profileUrl, true);
  set('email', input.email, true);
  set('phone', input.phone, true);

  const raw = bagOf(existing.raw);
  let rawChanged = false;
  if (input.raw !== undefined) {
    const incoming = bagOf(input.raw);
    for (const [k, v] of Object.entries(incoming)) {
      if (k.startsWith('_')) continue;
      if (JSON.stringify(raw[k]) !== JSON.stringify(v)) {
        raw[k] = v;
        rawChanged = true;
      }
    }
  }
  if (
    canonical &&
    JSON.stringify(raw._canonical ?? {}) !==
      JSON.stringify({ ...(raw._canonical ?? {}), ...canonical })
  ) {
    raw._canonical = { ...(raw._canonical ?? {}), ...canonical };
    rawChanged = true;
    signalsChanged = true;
  }

  let handleChange: { from: string; to: string } | null = null;
  if (input.handle && input.handle !== existing.handle) {
    if (existing.handle) handleChange = { from: existing.handle, to: input.handle };
    const history = raw._handleHistory ?? [];
    const open = history.find((h) => h.to === null);
    if (open) open.to = input.seenAt.toISOString();
    history.push({ handle: input.handle, from: input.seenAt.toISOString(), to: null });
    raw._handleHistory = history;
    rawChanged = true;
    data.handle = input.handle;
    signalsChanged = true;
  }
  if (rawChanged) data.raw = raw as Prisma.InputJsonValue;
  if (input.seenAt > existing.lastSeenAt) data.lastSeenAt = input.seenAt;
  if (Object.keys(data).length) await db.identity.update({ where: { id: existing.id }, data });

  if (handleChange) {
    await emitTimelineEvent(db, {
      workspaceId: input.workspaceId,
      dedupeKey: `handle:${existing.id}:${handleChange.from}:${handleChange.to}`,
      type: 'SYSTEM',
      occurredAt: input.seenAt,
      identityId: existing.id,
      recordId: existing.personRecordId,
      platform: input.platform,
      connectionId: input.connectionId ?? null,
      actorIdentityId: existing.id,
      summary: `Changed handle from @${handleChange.from} to @${handleChange.to}`,
      payload: { kind: 'handle_change', ...handleChange },
    });
  }
  return {
    id: existing.id,
    created: false,
    personRecordId: existing.personRecordId,
    handleChange,
    signalsChanged,
  };
}

/** Handle history from `raw`, newest first. */
export function handleHistoryOf(
  raw: unknown,
): { handle: string; from: string; to: string | null }[] {
  const bag = bagOf(raw);
  return [...(bag._handleHistory ?? [])].reverse();
}

export function canonicalOf(raw: unknown): {
  bio?: string;
  locale?: string;
  timezone?: string;
  companyExternalId?: string;
  linked?: { platform: Platform; externalId: string }[];
} {
  const bag = bagOf(raw);
  return bag._canonical ?? {};
}
