'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { ROLES, ROLE_LABEL } from '@/lib/roles';
import { useTRPC } from '@/lib/trpc-client';
import type { RouterOutputs } from '@/lib/trpc-types';

type Grant = RouterOutputs['connectionGrant']['list'][number];
type Member = RouterOutputs['member']['list'][number];

const PERMISSIONS = ['READ', 'ENGAGE', 'PUBLISH', 'CONFIGURE'] as const;

export function PermissionsView({
  connectionId,
  initialGrants,
  members,
}: {
  connectionId: string;
  initialGrants: Grant[];
  members: Member[];
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { data: grants } = useQuery({
    ...trpc.connectionGrant.list.queryOptions({ connectionId }),
    initialData: initialGrants,
  });
  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: trpc.connectionGrant.list.pathKey() });
  const create = useMutation(
    trpc.connectionGrant.create.mutationOptions({ onSuccess: invalidate }),
  );
  const remove = useMutation(
    trpc.connectionGrant.delete.mutationOptions({ onSuccess: invalidate }),
  );

  const [subjectType, setSubjectType] = useState<'ROLE' | 'USER'>('ROLE');
  const [subjectId, setSubjectId] = useState<string>(ROLES[3] ?? 'MEMBER');
  const [permission, setPermission] = useState<(typeof PERMISSIONS)[number]>('ENGAGE');

  const subjectLabel = (g: Grant) =>
    g.subjectType === 'ROLE'
      ? `Role: ${ROLE_LABEL[g.subjectId as keyof typeof ROLE_LABEL] ?? g.subjectId}`
      : (members.find((m) => m.userId === g.subjectId)?.name ?? g.subjectId);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-[var(--text-sm)] font-semibold tracking-tight">Grant access</h2>
        <p className="text-[var(--text-xs)] text-ink-muted">
          Per-connection grants add to a role's normal access — they never take it away. A member
          with no grant here can still read this connection if their base role allows it.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ connectionId, subjectType, subjectId, permission });
          }}
        >
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Who
            <select
              value={subjectType}
              onChange={(e) => {
                const next = e.target.value as 'ROLE' | 'USER';
                setSubjectType(next);
                setSubjectId(next === 'ROLE' ? (ROLES[3] ?? 'MEMBER') : (members[0]?.userId ?? ''));
              }}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5"
            >
              <option value="ROLE">A role</option>
              <option value="USER">A person</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            {subjectType === 'ROLE' ? 'Role' : 'Person'}
            <select
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5"
            >
              {subjectType === 'ROLE'
                ? ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))
                : members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name ?? m.email}
                    </option>
                  ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[var(--text-sm)]">
            Permission
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value as (typeof PERMISSIONS)[number])}
              className="rounded-[var(--radius-control)] border border-hairline bg-raised px-2 py-1.5"
            >
              {PERMISSIONS.map((p) => (
                <option key={p} value={p}>
                  {p.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={create.isPending || !subjectId}
          >
            {create.isPending ? 'Adding…' : 'Add grant'}
          </Button>
        </form>
        {create.error ? (
          <span role="alert" className="text-[var(--text-sm)] text-critical">
            {create.error.message}
          </span>
        ) : null}
      </Card>

      {grants.length === 0 ? (
        <EmptyState
          compact
          title="No per-connection grants yet"
          description="Everyone follows their normal workspace role for this connection."
        />
      ) : (
        <Card className="divide-y divide-[var(--border-hairline)]">
          {grants.map((g) => (
            <div
              key={g.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-[var(--text-sm)]"
            >
              <span>
                {subjectLabel(g)} —{' '}
                <span className="font-medium">{g.permission.toLowerCase()}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id: g.id })}
              >
                Remove
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
