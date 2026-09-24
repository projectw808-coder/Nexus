import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /** `session.user.id` is always present: the `session` callback in `auth.ts` sets it from the adapter user. */
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}
