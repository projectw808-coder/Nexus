import { LinkButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { InlineNotice } from '@/components/error-state';
import { RoleBadge } from '@/components/role-badge';
import { api } from '@/lib/api';
import { isCode } from '@/lib/errors';
import { formatDateTime, isoOf } from '@/lib/format';
import { ROLE_DESCRIPTION } from '@/lib/roles';
import { getSessionUser } from '@/lib/session';
import { acceptInvitationAction } from './actions';
import { AcceptForm } from './accept-form';

export const dynamic = 'force-dynamic';

const CLOSED: Record<
  'not_found' | 'expired' | 'revoked' | 'accepted',
  { title: string; description: string }
> = {
  not_found: {
    title: 'This invitation does not exist',
    description:
      'The link may be incomplete or mistyped. Ask the person who invited you to send it again.',
  },
  expired: {
    title: 'This invitation has expired',
    description: 'Invitation links are valid for 7 days. Ask a workspace admin to send a new one.',
  },
  revoked: {
    title: 'This invitation was revoked',
    description:
      'A workspace admin withdrew it. Ask them to invite you again if that was a mistake.',
  },
  accepted: {
    title: 'This invitation was already used',
    description:
      'If it was you, the workspace is in your list. If not, ask a workspace admin for a new link.',
  },
};

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [client, user] = await Promise.all([api(), getSessionUser()]);

  let preview: Awaited<ReturnType<typeof client.invitation.preview>>;
  try {
    preview = await client.invitation.preview({ token });
  } catch (e) {
    if (isCode(e, 'BAD_REQUEST')) preview = { ok: false, reason: 'not_found' };
    else throw e;
  }

  if (!preview.ok) {
    const copy = CLOSED[preview.reason];
    return (
      <div className="mx-auto max-w-lg">
        <EmptyState
          title={copy.title}
          description={copy.description}
          action={
            <LinkButton href={user ? '/' : '/sign-in'} variant="primary">
              {user ? 'Your workspaces' : 'Sign in'}
            </LinkButton>
          }
        />
      </div>
    );
  }

  const emailMismatch = user ? user.email.toLowerCase() !== preview.email.toLowerCase() : false;
  const callback = encodeURIComponent(`/invite/${token}`);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6">
      <div>
        <p className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted">
          Invitation
        </p>
        <h1 className="mt-1 text-[var(--text-xl)] font-semibold tracking-tight">
          Join {preview.workspaceName}
        </h1>
        <p className="mt-1 text-ink-secondary">
          You have been invited to work in this workspace on Nexus.
        </p>
      </div>

      <dl className="rounded-[var(--radius-card)] border border-hairline bg-card px-4">
        <div className="grid grid-cols-[8rem_1fr] items-center gap-4 border-b border-hairline py-2.5">
          <dt className="text-[var(--text-sm)] text-ink-muted">Workspace</dt>
          <dd className="font-medium">{preview.workspaceName}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] items-center gap-4 border-b border-hairline py-2.5">
          <dt className="text-[var(--text-sm)] text-ink-muted">Role</dt>
          <dd className="flex items-center gap-2">
            <RoleBadge role={preview.role} />
            <span className="text-[var(--text-sm)] text-ink-secondary">
              {ROLE_DESCRIPTION[preview.role]}
            </span>
          </dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] items-center gap-4 border-b border-hairline py-2.5">
          <dt className="text-[var(--text-sm)] text-ink-muted">Sent to</dt>
          <dd>{preview.email}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] items-center gap-4 py-2.5">
          <dt className="text-[var(--text-sm)] text-ink-muted">Valid until</dt>
          <dd className="tnum">
            <time dateTime={isoOf(preview.expiresAt)}>{formatDateTime(preview.expiresAt)}</time>
          </dd>
        </div>
      </dl>

      {user ? (
        <div className="flex flex-col gap-3">
          {emailMismatch ? (
            <InlineNotice tone="warning">
              You are signed in as {user.email}, but this invitation was sent to {preview.email}.
              Accepting will be refused unless you sign in with that address.
            </InlineNotice>
          ) : null}
          <AcceptForm
            action={acceptInvitationAction.bind(null, token)}
            workspaceName={preview.workspaceName}
          />
          {emailMismatch ? (
            <LinkButton
              href={`/sign-in?callbackUrl=${callback}`}
              variant="secondary"
              className="self-start"
            >
              Sign in as {preview.email}
            </LinkButton>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <LinkButton
            href={`/sign-in?callbackUrl=${callback}`}
            variant="primary"
            className="self-start"
          >
            Sign in to accept
          </LinkButton>
          <p className="text-[var(--text-sm)] text-ink-muted">
            Sign in with {preview.email}; you will come straight back here.
          </p>
        </div>
      )}
    </div>
  );
}
