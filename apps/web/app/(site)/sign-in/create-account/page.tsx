import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { SubmitButton } from '@/components/submit-button';
import { createAccount } from '../actions';
import { firstParam, safeCallbackUrl } from '../callback-url';
import { authErrorMessage } from '../messages';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CreateAccountPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(firstParam(params['callbackUrl']));
  const error = authErrorMessage(firstParam(params['error']));

  const session = await auth();
  if (session?.user) redirect('/');

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <section>
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">Create an account</h1>
        <p className="mt-1 text-ink-secondary">Set an email and a password to sign in with.</p>
      </section>

      {error && (
        <div
          role="alert"
          className="flex gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4 text-[var(--text-sm)]"
        >
          <span
            aria-hidden
            className="mt-1.5 inline-block size-2.5 shrink-0 rounded-full"
            style={{ background: 'var(--status-critical)' }}
          />
          <div>
            <p className="font-medium">
              <span className="sr-only">Error: </span>
              {error.title}
            </p>
            <p className="mt-0.5 text-ink-secondary">{error.body}</p>
          </div>
        </div>
      )}

      <form
        action={createAccount}
        className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
      >
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label htmlFor="name" className="text-[var(--text-sm)] font-medium">
          Name (optional)
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          autoFocus
          placeholder="Ada Lovelace"
          className="h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-hairline bg-page px-3 text-[var(--text-sm)] placeholder:text-ink-muted"
        />
        <label htmlFor="email" className="text-[var(--text-sm)] font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          className="h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-hairline bg-page px-3 text-[var(--text-sm)] placeholder:text-ink-muted"
        />
        <label htmlFor="password" className="text-[var(--text-sm)] font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          placeholder="At least 8 characters"
          className="h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-hairline bg-page px-3 text-[var(--text-sm)] placeholder:text-ink-muted"
        />
        <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
      </form>

      <p className="text-center text-[var(--text-sm)] text-ink-secondary">
        Already have an account?{' '}
        <Link
          href={`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`}
          className="font-medium text-ink underline"
        >
          Log in
        </Link>
      </p>
    </div>
  );
}
