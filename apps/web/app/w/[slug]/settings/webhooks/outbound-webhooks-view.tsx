'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { LocalDateTime } from '@/components/local-time';
import { StatusPill, type PillTone } from '@/components/status-pill';
import { isoOf } from '@/lib/format';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Subscription = RouterOutputs['outboundWebhook']['list'][number];
type Catalog = RouterOutputs['outboundWebhook']['catalog'];
type Delivery = RouterOutputs['outboundWebhook']['deliveries'][number];

const STATUS_TONE: Record<Delivery['status'], PillTone> = {
  PENDING: 'info',
  DELIVERED: 'good',
  FAILED: 'warning',
  DEAD_LETTERED: 'critical',
};

const STATUS_LABEL: Record<Delivery['status'], string> = {
  PENDING: 'queued',
  DELIVERED: 'delivered',
  FAILED: 'retrying',
  DEAD_LETTERED: 'gave up',
};

export function OutboundWebhooksView({
  initial,
  catalog,
  canManage,
}: {
  initial: Subscription[];
  catalog: Catalog;
  canManage: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery({ ...trpc.outboundWebhook.list.queryOptions(), initialData: initial });
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: trpc.outboundWebhook.list.pathKey() });

  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>(['record.created']);
  const [revealed, setRevealed] = useState<{ url: string; secret: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const create = useMutation(
    trpc.outboundWebhook.create.mutationOptions({
      onSuccess: (result) => {
        invalidate();
        setRevealed({ url: result.subscription.url, secret: result.secretPlaintext });
        setUrl('');
        setDescription('');
        setEvents(['record.created']);
      },
    }),
  );
  const update = useMutation(
    trpc.outboundWebhook.update.mutationOptions({ onSuccess: invalidate }),
  );
  const remove = useMutation(
    trpc.outboundWebhook.delete.mutationOptions({ onSuccess: invalidate }),
  );
  const rotate = useMutation(
    trpc.outboundWebhook.rotateSecret.mutationOptions({
      onSuccess: (result, variables) => {
        invalidate();
        const target = list.data.find((s) => s.id === variables.id);
        setRevealed({ url: target?.url ?? '', secret: result.secretPlaintext });
      },
    }),
  );
  const error = create.error ?? update.error ?? remove.error ?? rotate.error;

  const toggleEvent = (name: string) =>
    setEvents((current) =>
      current.includes(name) ? current.filter((e) => e !== name) : [...current, name],
    );

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[var(--text-sm)] text-ink-secondary">
        Nexus POSTs a JSON body to your endpoint when something happens in this workspace. Every
        request is signed with HMAC-SHA256 and timestamped in{' '}
        <code className="font-mono text-[var(--text-xs)]">{catalog.signatureHeader}</code>:{' '}
        <code className="font-mono text-[var(--text-xs)]">
          t=&lt;unix seconds&gt;,v1=&lt;hex&gt;
        </code>{' '}
        over <code className="font-mono text-[var(--text-xs)]">{'`${t}.${rawBody}`'}</code>. Failed
        deliveries retry with exponential backoff, six times, and can be replayed below.
      </p>

      {revealed ? (
        <Card className="flex flex-col gap-2 border-[var(--status-warning-bg)] p-4">
          <h2 className="text-[var(--text-md)] font-semibold tracking-tight">
            Signing secret for {revealed.url || 'this endpoint'}
          </h2>
          <p className="text-[var(--text-sm)] text-warning">
            Copy this now — you will not see it again. Nexus stores it encrypted and can never show
            it to you a second time.
          </p>
          <code className="select-all break-all rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-2 font-mono text-[var(--text-sm)]">
            {revealed.secret}
          </code>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
              I have copied it
            </Button>
          </div>
        </Card>
      ) : null}

      {canManage ? (
        <form
          className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim() || events.length === 0) return;
            create.mutate({
              url: url.trim(),
              events: events as Parameters<typeof create.mutate>[0]['events'],
              description: description.trim() || null,
            });
          }}
        >
          <h2 className="text-[var(--text-md)] font-semibold tracking-tight">New endpoint</h2>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Endpoint URL <span className="text-ink-muted">(https only)</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://example.com/hooks/nexus"
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 font-mono text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Description <span className="text-ink-muted">(optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-3 py-1.5 text-ink"
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[var(--text-sm)]">Events</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {catalog.events.map((e) => (
                <label
                  key={e.name}
                  className="flex items-start gap-2 text-[var(--text-sm)]"
                  title={e.description}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={events.includes(e.name)}
                    onChange={() => toggleEvent(e.name)}
                  />
                  <span>
                    <span className="font-mono text-[var(--text-xs)]">{e.name}</span>
                    <span className="block text-[var(--text-xs)] text-ink-muted">
                      {e.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              disabled={create.isPending || !url.trim() || events.length === 0}
            >
              {create.isPending ? 'Creating…' : 'Create endpoint'}
            </Button>
            {error ? (
              <span role="alert" className="text-[var(--text-sm)] text-critical">
                {error.message}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      <section aria-labelledby="endpoints-heading" className="flex flex-col gap-3">
        <h2 id="endpoints-heading" className="text-[var(--text-md)] font-semibold tracking-tight">
          Endpoints <span className="tnum font-normal text-ink-muted">({list.data.length})</span>
        </h2>
        {list.data.length === 0 ? (
          <EmptyState
            compact
            title="No webhook endpoints yet"
            description="Add an https endpoint above and Nexus will start posting signed events to it."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {list.data.map((s) => (
              <Card key={s.id} className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={s.enabled ? 'good' : 'neutral'} glyph={null}>
                    {s.enabled ? 'enabled' : 'paused'}
                  </StatusPill>
                  <span className="break-all font-mono text-[var(--text-sm)]">{s.url}</span>
                  <span className="ml-auto flex items-center gap-1 text-[var(--text-xs)] text-ink-muted tnum">
                    <span>{s.counts.DELIVERED} delivered</span>
                    <span>·</span>
                    <span>{s.counts.FAILED} retrying</span>
                    <span>·</span>
                    <span>{s.counts.DEAD_LETTERED} gave up</span>
                  </span>
                </div>
                {s.description ? (
                  <p className="text-[var(--text-sm)] text-ink-secondary">{s.description}</p>
                ) : null}
                <p className="flex flex-wrap gap-1">
                  {s.events.map((e) => (
                    <span
                      key={e}
                      className="rounded-[var(--radius-pill)] border border-hairline px-2 py-0.5 font-mono text-[var(--text-xs)] text-ink-secondary"
                    >
                      {e}
                    </span>
                  ))}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    aria-expanded={expanded === s.id}
                  >
                    {expanded === s.id ? 'Hide deliveries' : 'Deliveries'}
                  </Button>
                  {canManage ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: s.id, enabled: !s.enabled })}
                      >
                        {s.enabled ? 'Pause' : 'Enable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rotate.isPending}
                        onClick={() => rotate.mutate({ id: s.id })}
                      >
                        Rotate secret
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ id: s.id })}
                      >
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
                {expanded === s.id ? (
                  <DeliveryLog subscriptionId={s.id} canManage={canManage} />
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function DeliveryLog({
  subscriptionId,
  canManage,
}: {
  subscriptionId: string;
  canManage: boolean;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const deliveries = useQuery(trpc.outboundWebhook.deliveries.queryOptions({ subscriptionId }));
  const replay = useMutation(
    trpc.outboundWebhook.replay.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.outboundWebhook.deliveries.pathKey() });
        void qc.invalidateQueries({ queryKey: trpc.outboundWebhook.list.pathKey() });
      },
    }),
  );

  if (deliveries.isPending)
    return <p className="text-[var(--text-sm)] text-ink-muted">Loading deliveries…</p>;
  if (deliveries.error)
    return (
      <p role="alert" className="text-[var(--text-sm)] text-critical">
        {deliveries.error.message}
      </p>
    );
  if (deliveries.data.length === 0)
    return (
      <EmptyState
        compact
        title="No deliveries yet"
        description="Events matching this endpoint's subscription will show up here as they are sent."
      />
    );

  return (
    <div className="flex flex-col gap-1">
      {replay.error ? (
        <p role="alert" className="text-[var(--text-sm)] text-critical">
          {replay.error.message}
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--border-hairline)] rounded-[var(--radius-card)] border border-hairline">
        {deliveries.data.map((d) => (
          <li key={d.id} className="flex flex-col gap-1 px-3 py-2 text-[var(--text-sm)]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={STATUS_TONE[d.status]} glyph={null}>
                {STATUS_LABEL[d.status]}
              </StatusPill>
              <span className="font-mono text-[var(--text-xs)]">{d.eventType}</span>
              <LocalDateTime iso={isoOf(d.createdAt) ?? ''} />
              <span className="text-[var(--text-xs)] text-ink-muted tnum">
                {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                {d.responseStatus === null ? '' : ` · HTTP ${d.responseStatus}`}
              </span>
              {canManage && d.status !== 'PENDING' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={replay.isPending}
                  onClick={() => replay.mutate({ id: d.id })}
                >
                  Replay
                </Button>
              ) : null}
            </div>
            {d.status === 'FAILED' && d.nextAttemptAt ? (
              <p className="text-[var(--text-xs)] text-ink-muted">
                Next attempt <LocalDateTime iso={isoOf(d.nextAttemptAt) ?? ''} />
              </p>
            ) : null}
            {d.responseBody && d.status !== 'DELIVERED' ? (
              <p className="break-all font-mono text-[var(--text-xs)] text-ink-muted">
                {d.responseBody.slice(0, 300)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
