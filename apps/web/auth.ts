/**
 * Auth.js v5 for the web app. Server only — never import from a client component.
 *
 * Sign-in methods:
 *  - `credentials`         email + password, always on. `authorize()` verifies against
 *                         `User.passwordHash` (scrypt, `@/lib/password`).
 *  - `google`             only when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set.
 *  - `microsoft-entra-id` only when the three AUTH_MICROSOFT_ENTRA_ID_* values are set.
 *
 * Sessions are JWT, not database-backed: Auth.js's Credentials provider cannot create an
 * adapter session (it has no OAuth callback to hang one off), so it requires `strategy: 'jwt'`.
 * Nothing else in the app reads the `Session` table directly, so this has no other effect.
 * The `adapter` is kept only for the OAuth providers' account linking.
 */
import { loadEnv } from '@nexus/config';
import { authAdapter, findUserByEmailForCredentials } from '@nexus/db';
import NextAuth, { type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { verifyPassword } from '@/lib/password';

export const CREDENTIALS_PROVIDER_ID = 'credentials';
export type OAuthProviderId = 'google' | 'microsoft-entra-id';
export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  google: 'Google',
  'microsoft-entra-id': 'Microsoft',
};

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

function credentialsProvider() {
  return Credentials({
    id: CREDENTIALS_PROVIDER_ID,
    name: 'Email and password',
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(raw) {
      const email = typeof raw?.email === 'string' ? raw.email.trim().toLowerCase() : '';
      const password = typeof raw?.password === 'string' ? raw.password : '';
      if (!email || !password) return null;

      const user = await findUserByEmailForCredentials(email);
      if (!user?.passwordHash) return null;
      if (!(await verifyPassword(password, user.passwordHash))) return null;

      return { id: user.id, email: user.email, name: user.name };
    },
  });
}

let cached: NextAuthConfig | undefined;

function buildConfig(): NextAuthConfig {
  if (cached) return cached;
  const env = loadEnv();

  const providers: NextAuthConfig['providers'] = [credentialsProvider()];
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
    session: { strategy: 'jwt' },
    providers,
    secret: env.AUTH_SECRET,
    trustHost: env.AUTH_TRUST_HOST,
    pages: {
      signIn: '/sign-in',
      error: '/sign-in/error',
    },
    callbacks: {
      // Explicit rather than relying on Auth.js's default user->token merge: `id` is not a
      // standard JWT claim, and getting it (and email/name) wrong here means every
      // `requireSessionUser()` call downstream silently sees a broken session.
      jwt({ token, user }) {
        if (user) {
          token.sub = user.id;
          token.email = user.email;
          token.name = user.name;
        }
        return token;
      },
      session({ session, token }) {
        if (token.sub) session.user.id = token.sub;
        if (typeof token.email === 'string') session.user.email = token.email;
        if (typeof token.name === 'string') session.user.name = token.name;
        return session;
      },
    },
  };
  return cached;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildConfig());
