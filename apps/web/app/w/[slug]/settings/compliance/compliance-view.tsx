'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Role } from '@nexus/db';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { LocalDateTime } from '@/components/local-time';
import { StatusPill, type PillTone } from '@/components/status-pill';
import { platformName } from '@/lib/platforms';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Initial = {
  requests: RouterOutputs['dataSubjectRequest']['list'];
  consent: RouterOutputs['consent']['list'];
  notes: RouterOutputs['complianceNote']['list'];
  identities: RouterOutputs['identity']['list'];
};

const DSR_TONE: Record<string, PillTone> = {
  RECEIVED: 'info',
  IN_PROGRESS: 'info',
  EXPORT_READY: 'warning',
  COMPLETED: 'good',
  REJECTED: 'neutral',
};

const CONSENT_TONE: Record<string, PillTone> = {
  UNKNOWN: 'neutral',
  GRANTED: 'good',
  WITHDRAWN: 'critical',
};

const KIND_LABEL: Record<string, string> = {
  ACCESS: 'Access',
  PORTABILITY: 'Portability',
  ERASURE: 'Erasure',
  RECTIFICATION: 'Rectification',
};

type Tombstone = { removed?: { table: string; count: number }[] } | null;

export function ComplianceView({
  initial,
  canManageRequests,
  canRecordConsent,
  role,
}: {
  initial: Initial;
  canManageRequests: boolean;
  canRecordConsent: boolean;
  role: Role;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const requests = useQuery({
    ...trpc.dataSubjectRequest.list.queryOptions({}),
    initialData: initial.requests,
  });
  const consent = useQuery({
    ...trpc.consent.list.queryOptions({}),
    initialData: initial.consent,
  });
  const notes = useQuery({
    ...trpc.complianceNote.list.queryOptions({}),
    initialData: initial.notes,
  });
  const identities = useQuery({
    ...trpc.identity.list.queryOptions({ limit: 100 }),
    initialData: initial.identities,
  });

  const invalidateRequests = () =>
    void qc.invalidateQueries({ queryKey: trpc.dataSubjectRequest.list.pathKey() });
  const invalidateConsent = () =>
    void qc.invalidateQueries({ queryKey: trpc.consent.list.pathKey() });

  const createRequest = useMutation(
    trpc.dataSubjectRequest.create.mutationOptions({
      onSuccess: () => {
        invalidateRequests();
        setSubject('');
      },
    }),
  );
  const release = useMutation(
    trpc.dataSubjectRequest.release.mutationOptions({ onSuccess: invalidateRequests }),
  );
  const reject = useMutation(
    trpc.dataSubjectRequest.reject.mutationOptions({ onSuccess: invalidateRequests }),
  );
  const setConsent = useMutation(
    trpc.consent.record.mutationOptions({ onSuccess: invalidateConsent }),
  );

  const [kind, setKind] = useState<'ACCESS' | 'PORTABILITY' | 'ERASURE' | 'RECTIFICATION'>(
    'ACCESS',
  );
  const [subject, setSubject] = useState('');
  const [identityId, setIdentityId] = useState('');
  const [channel, setChannel] = useState('email');
  const [confirmErasure, setConfirmErasure] = useState(false);

  const requestError = createRequest.error ?? release.error ?? reject.error;
  const looksLikeEmail = subject.includes('@');

  return (
    <div className="flex flex-col gap-8">
      {/* ── Data-subject requests ─────────────────────────────────────────── */}
      <section aria-labelledby="dsr-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="dsr-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Data-subject requests
          </h2>
          <p className="text-[var(--text-sm)] text-ink-secondary">
            Access and portability requests produce a portable export and wait for a person to
            release it. An erasure hard-deletes every trace of the subject across every channel and
            leaves a tombstone on the request itself.
          </p>
        </div>

        {canManageRequests ? (
          <Card className="flex flex-col gap-3 p-4">
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!subject.trim()) return;
                createRequest.mutate({
                  kind,
                  ...(looksLikeEmail
                    ? { subjectEmail: subject.trim() }
                    : { subjectPhone: subject.trim() }),
                });
                setConfirmErasure(false);
              }}
            >
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-[var(--text-sm)]">
                  Kind
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKind(e.target.value as typeof kind);
                      setConfirmErasure(false);
                    }}
                    className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-ink"
                  >
                    {Object.entries(KIND_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-64 flex-1 flex-col gap-1 text-[var(--text-sm)]">
                  Subject <span className="text-ink-muted">(email or phone number)</span>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    required
                    maxLength={200}
                    placeholder="dana@example.com"
                    className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-hairline bg-raised px-3 text-ink"
                  />
                </label>
                <Button
                  type="submit"
                  variant={kind === 'ERASURE' ? 'danger' : 'primary'}
                  disabled={
                    createRequest.isPending ||
                    !subject.trim() ||
                    (kind === 'ERASURE' && !confirmErasure)
                  }
                >
                  {createRequest.isPending ? 'Filing…' : 'File request'}
                </Button>
              </div>
              {kind === 'ERASURE' ? (
                <label className="flex items-start gap-2 text-[var(--text-sm)] text-critical">
                  <input
                    type="checkbox"
                    checked={confirmErasure}
                    onChange={(e) => setConfirmErasure(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    I understand this permanently deletes this person&rsquo;s messages, timeline,
                    notes, AI insights and raw platform payloads. It cannot be undone — only the
                    request and its tombstone survive.
                  </span>
                </label>
              ) : null}
            </form>
            {requestError ? (
              <ErrorState
                title="That request could not be filed"
                message={requestError.message}
                remediation="Check the subject identifier and try again."
              />
            ) : null}
          </Card>
        ) : (
          <p className="text-[var(--text-sm)] text-ink-muted">
            Your role ({role.toLowerCase()}) can read this queue but not file or decide requests.
          </p>
        )}

        {requests.isPending ? (
          <p className="text-[var(--text-sm)] text-ink-muted">Loading requests…</p>
        ) : requests.error ? (
          <ErrorState
            message={requests.error.message}
            onRetry={() => void requests.refetch()}
            remediation="The queue could not be read."
          />
        ) : requests.data.length === 0 ? (
          <EmptyState
            compact
            title="No data-subject requests"
            description="When someone asks for a copy of their data or asks to be forgotten, file it here and the job runs immediately."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {requests.data.map((r) => {
              const tombstone = r.tombstone as Tombstone;
              const removed = tombstone?.removed ?? [];
              return (
                <li key={r.id} className="flex flex-col gap-1.5 px-4 py-3 text-[var(--text-sm)]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">{KIND_LABEL[r.kind] ?? r.kind}</span>
                    <StatusPill tone={DSR_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>
                    <span className="text-ink-secondary">
                      {r.subjectEmail ?? r.subjectPhone ?? r.subjectRecordId ?? '(no selector)'}
                    </span>
                    <span className="text-ink-muted">
                      filed <LocalDateTime iso={new Date(r.requestedAt).toISOString()} />
                      {r.requestedBy ? ` by ${r.requestedBy.name ?? r.requestedBy.email}` : ''}
                    </span>
                    {canManageRequests && r.status === 'EXPORT_READY' ? (
                      <span className="ml-auto flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => release.mutate({ id: r.id })}
                          disabled={release.isPending}
                        >
                          Release export
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            reject.mutate({ id: r.id, reason: 'Requester could not be verified.' })
                          }
                          disabled={reject.isPending}
                        >
                          Reject
                        </Button>
                      </span>
                    ) : null}
                  </div>
                  {r.exportRef ? (
                    <p className="font-mono text-[var(--text-xs)] text-ink-muted">
                      export {r.exportRef}
                    </p>
                  ) : null}
                  {removed.length > 0 ? (
                    <p className="text-[var(--text-xs)] text-ink-muted">
                      Tombstone: {removed.map((t) => `${t.count} × ${t.table}`).join(', ')}
                    </p>
                  ) : null}
                  {r.notes ? <p className="text-ink-secondary">{r.notes}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Consent ───────────────────────────────────────────────────────── */}
      <section aria-labelledby="consent-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="consent-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Consent
          </h2>
          <p className="text-[var(--text-sm)] text-ink-secondary">
            A withdrawal blocks workflow-driven sends to that person on that channel. A human
            replying to an inbound message is never blocked — that is a transactional answer, not
            marketing.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(['GRANTED', 'WITHDRAWN', 'UNKNOWN'] as const).map((s) => (
            <StatusPill key={s} tone={CONSENT_TONE[s]!}>
              {consent.data.counts[s]} {s.toLowerCase()}
            </StatusPill>
          ))}
        </div>

        {canRecordConsent ? (
          <Card className="p-4">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!identityId) return;
                setConsent.mutate({
                  identityId,
                  channel,
                  status: 'WITHDRAWN',
                  source: 'manual',
                });
              }}
            >
              <label className="flex min-w-64 flex-1 flex-col gap-1 text-[var(--text-sm)]">
                Identity
                <select
                  value={identityId}
                  onChange={(e) => setIdentityId(e.target.value)}
                  required
                  className="h-[var(--control-height)] rounded-[var(--radius-control)] border border-hairline bg-raised px-2 text-ink"
                >
                  <option value="">Pick a channel identity…</option>
                  {identities.data.map((i) => (
                    <option key={i.id} value={i.id}>
                      {platformName(i.platform)} · {i.handle ?? i.displayName ?? i.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[var(--text-sm)]">
                Channel
                <input
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  required
                  maxLength={40}
                  className="h-[var(--control-height)] w-40 rounded-[var(--radius-control)] border border-hairline bg-raised px-3 text-ink"
                />
              </label>
              <Button type="submit" variant="danger" disabled={setConsent.isPending || !identityId}>
                {setConsent.isPending ? 'Saving…' : 'Record withdrawal'}
              </Button>
              {setConsent.error ? (
                <span role="alert" className="text-[var(--text-sm)] text-critical">
                  {setConsent.error.message}
                </span>
              ) : null}
            </form>
          </Card>
        ) : null}

        {consent.isPending ? (
          <p className="text-[var(--text-sm)] text-ink-muted">Loading consent…</p>
        ) : consent.error ? (
          <ErrorState message={consent.error.message} onRetry={() => void consent.refetch()} />
        ) : consent.data.rows.length === 0 ? (
          <EmptyState
            compact
            title="No consent recorded yet"
            description="Every identity starts as “unknown”, which does not block anything. Record a withdrawal when someone asks not to be contacted."
          />
        ) : (
          <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline bg-card">
            {consent.data.rows.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[var(--text-sm)]"
              >
                <span className="font-medium">
                  {c.identity.handle ?? c.identity.displayName ?? c.identity.email ?? c.identityId}
                </span>
                <span className="text-ink-muted">{platformName(c.identity.platform)}</span>
                <span className="text-ink-secondary">{c.channel}</span>
                <StatusPill tone={CONSENT_TONE[c.status] ?? 'neutral'}>{c.status}</StatusPill>
                {c.source ? <span className="text-ink-muted">via {c.source}</span> : null}
                <span className="text-ink-muted">
                  <LocalDateTime iso={new Date(c.capturedAt).toISOString()} />
                </span>
                {canRecordConsent ? (
                  <Button
                    size="sm"
                    variant={c.status === 'WITHDRAWN' ? 'secondary' : 'danger'}
                    className="ml-auto"
                    onClick={() =>
                      setConsent.mutate({
                        identityId: c.identityId,
                        channel: c.channel,
                        status: c.status === 'WITHDRAWN' ? 'GRANTED' : 'WITHDRAWN',
                        source: 'manual',
                      })
                    }
                    disabled={setConsent.isPending}
                  >
                    {c.status === 'WITHDRAWN' ? 'Restore consent' : 'Withdraw'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Platform compliance notes ─────────────────────────────────────── */}
      <section aria-labelledby="notes-heading" className="flex flex-col gap-3">
        <div>
          <h2 id="notes-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
            Platform terms
          </h2>
          <p className="text-[var(--text-sm)] text-ink-secondary">
            What each connected platform&rsquo;s own terms require of us. Read-only and maintained
            by the operator, not per workspace.
          </p>
        </div>
        {notes.isPending ? (
          <p className="text-[var(--text-sm)] text-ink-muted">Loading notes…</p>
        ) : notes.error ? (
          <ErrorState message={notes.error.message} onRetry={() => void notes.refetch()} />
        ) : notes.data.notes.length === 0 ? (
          <EmptyState
            compact
            title="No notes for your connected platforms"
            description={
              notes.data.platforms.length === 0
                ? 'Connect a platform and its terms constraints appear here.'
                : 'Nothing has been recorded for these platforms yet.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.data.notes.map((n) => (
              <li key={n.id}>
                <Card className="flex flex-col gap-1 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="neutral" glyph={null}>
                      {platformName(n.platform)}
                    </StatusPill>
                    <span className="text-[var(--text-sm)] font-medium">{n.title}</span>
                  </div>
                  <p className="text-[var(--text-sm)] text-ink-secondary">{n.body}</p>
                  {n.sourceUrl ? (
                    <a
                      href={n.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[var(--text-xs)] text-ink-muted underline"
                    >
                      {n.sourceUrl}
                    </a>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
