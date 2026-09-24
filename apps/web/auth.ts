/**
 * Auth.js v5 for the web app. Server only — never import from a client component.
 *
 * Sign-in methods:
 *  - `email`              magic link, always on. The verification mail is rendered by
 *                         `lib/mail/templates/magic-link.ts` and sent through the `MailProvider`
 *                         (Mailpit locally, SMTP in prod, in-memory in tests) rather than by
 *                         Auth.js's built-in nodemailer path.
 *  - `google`             only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
 *  - `microsoft-entra-id` only when the three AUTH_MICROSOFT_ENTRA_ID_* values are set.
 *
 * Sessions live in the database (`Session` table) via the adapter in @nexus/db, which also
 * translates Auth.js's `image` to our `avatarUrl`. The config is built on first request so
 * `loadEnv()` is not evaluated at import time.
 */
import { loadEnv } from '@nexus/config';
import { authAdapter } from '@nexus/db';
import NextAuth, { type NextAuthConfig } from 'next-auth';
import type { EmailConfig } from 'next-auth/providers/email';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { getMailProvider } from '@/lib/mail/provider';
import { magicLinkEmail } from '@/lib/mail/templates/magic-link';

export const EMAIL_PROVIDER_ID = 'email';
export type OAuthProviderId = 'google' | 'microsoft-entra-id';
export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  google: 'Google',
  'microsoft-entra-id': 'Microsoft',
};

/** Magic links stay valid for a day; they are single-use regardless. */
export const MAGIC_LINK_MAX_AGE_SECONDS = 24 * 60 * 60;

/** The OAuth providers whose credentials are present. Used to decide which buttons to render. */
export function configuredProviders(): OAuthProviderId[] {
  const env = loadEnv();
  const ids: OAuthProviderId[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ids.push('google');
  if (
    env.AUTH_MICROSOFT_ENTRA_ID_ID &&
    env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
    env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
  ) {
    ids.push('microsoft-entra-id');
  }
  return ids;
}

/**
 * A custom email provider: the plain `{ id, type: 'email', sendVerificationRequest }` shape
 * Auth.js accepts, with no nodemailer `server` — sending is our MailProvider's job.
 */
function emailProvider(from: string): EmailConfig {
  return {
    id: EMAIL_PROVIDER_ID,
    type: 'email',
    name: 'Email',
    from,
    maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
    async sendVerificationRequest({ identifier, url, expires }) {
      const message = magicLinkEmail({ url, host: new URL(url).host, expires });
      const result = await getMailProvider().send({
        to: identifier,
        kind: 'auth.magic_link',
        ...message,
      });
      // A thrown error becomes Auth.js's `EmailSignInError`, which the sign-in page renders.
      if (!result.ok) throw result.error;
    },
  };
}

let cached: NextAuthConfig | undefined;

function buildConfig(): NextAuthConfig {
  if (cached) return cached;
  const env = loadEnv();

  const providers: NextAuthConfig['providers'] = [emailProvider(env.EMAIL_FROM)];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      Google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
    );
  }
  if (
    env.AUTH_MICROSOFT_ENTRA_ID_ID &&
    env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
    env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
  ) {
    providers.push(
      MicrosoftEntraID({
        clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      }),
    );
  }

  cached = {
    adapter: authAdapter(),
    session: { strategy: 'database' },
    providers,
    secret: env.AUTH_SECRET,
    trustHost: env.AUTH_TRUST_HOST,
    pages: {
      signIn: '/sign-in',
      verifyRequest: '/sign-in/check-email',
      error: '/sign-in/error',
    },
    callbacks: {
      session(params) {
        // With database sessions Auth.js hands us the adapter user; expose its id.
        if ('user' in params && params.user) {
          params.session.user.id = params.user.id;
        }
        return params.session;
      },
    },
  };
  return cached;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildConfig());
