import { redirect } from 'next/navigation';
import { auth, configuredProviders, OAUTH_PROVIDER_LABELS } from '@/auth';
import { SubmitButton } from '@/components/submit-button';
import { sendMagicLink, signInWithProvider } from './actions';
import { firstParam, safeCallbackUrl } from './callback-url';
import { authErrorMessage } from './messages';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackUrl(firstParam(params['callbackUrl']));
  const error = authErrorMessage(firstParam(params['error']));

  const session = await auth();
  if (session?.user) redirect('/');

  const providers = configuredProviders();

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <section>
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-ink-secondary">
          We&rsquo;ll email you a link. No password to remember.
        </p>
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
        action={sendMagicLink}
        className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-card p-4"
      >
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <label htmlFor="email" className="text-[var(--text-sm)] font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="you@company.com"
          className="h-[var(--control-height)] w-full rounded-[var(--radius-control)] border border-hairline bg-page px-3 text-[var(--text-sm)] placeholder:text-ink-muted"
        />
        <SubmitButton pendingLabel="Sending…">Send me a sign-in link</SubmitButton>
      </form>

      {providers.length > 0 && (
        <section aria-labelledby="providers" className="flex flex-col gap-2">
          <h2
            id="providers"
            className="text-[var(--text-xs)] font-medium uppercase tracking-wide text-ink-muted"
          >
            Or continue with
          </h2>
          {providers.map((id) => (
            <form key={id} action={signInWithProvider.bind(null, id, callbackUrl)}>
              <SubmitButton
                variant="secondary"
                pendingLabel={`Opening ${OAUTH_PROVIDER_LABELS[id]}…`}
              >
                Continue with {OAUTH_PROVIDER_LABELS[id]}
              </SubmitButton>
            </form>
          ))}
        </section>
      )}
    </div>
  );
}
