import Link from 'next/link';
import { firstParam } from '../callback-url';
import { authErrorMessage } from '../messages';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Auth.js's `pages.error` target: `?error=Configuration|AccessDenied|Verification|…`. */
export default async function SignInErrorPage({ searchParams }: { searchParams: SearchParams }) {
  const code = firstParam((await searchParams)['error']);
  const message = authErrorMessage(code ?? 'Default') ?? authErrorMessage('Default');

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6 py-8">
      <section>
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">
          <span className="sr-only">Error: </span>
          {message?.title}
        </h1>
        <p className="mt-1 text-ink-secondary">{message?.body}</p>
      </section>

      <p className="text-[var(--text-sm)]">
        <Link href="/sign-in" className="text-link underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
