import Link from 'next/link';
import { firstParam } from '../callback-url';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Shown after a magic link is requested. Auth.js's own `verifyRequest` redirect lands here too
 * (without `?email=`), so the address is optional.
 */
export default async function CheckEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const email = firstParam((await searchParams)['email'])?.trim();

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <section>
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-1 text-ink-secondary">
          {email ? (
            <>
              We sent a sign-in link to <span className="font-medium text-ink">{email}</span>.
            </>
          ) : (
            'We sent a sign-in link to the address you entered.'
          )}
        </p>
      </section>

      <div className="rounded-[var(--radius-card)] border border-hairline bg-card p-4 text-[var(--text-sm)] text-ink-secondary">
        <p>Open the email and follow the link. It works once and expires in 24 hours.</p>
        <p className="mt-2">
          Nothing there? Give it a minute and check the spam folder. Locally, mail lands in Mailpit.
        </p>
      </div>

      <p className="text-[var(--text-sm)]">
        <Link href="/sign-in" className="text-link underline-offset-2 hover:underline">
          Use a different address
        </Link>
      </p>
    </div>
  );
}
