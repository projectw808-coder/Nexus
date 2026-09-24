/**
 * Human wording for the `?error=` codes Auth.js (and our own actions) can send to the sign-in
 * and error pages. Codes come from Auth.js's `SignInPageErrorParam`, `ErrorPageParam` and the
 * `AuthError.type` values a server action can catch; the rest are ours.
 */
export type AuthErrorMessage = { title: string; body: string };

const MESSAGES: Record<string, AuthErrorMessage> = {
  OAuthAccountNotLinked: {
    title: 'That email already has an account',
    body: 'Sign in the way you did the first time — with the sign-in link — and you can connect this provider from your profile afterwards.',
  },
  AccessDenied: {
    title: 'Sign-in was not allowed',
    body: 'Your account is not permitted to sign in here. If you think it should be, ask a workspace admin to invite you.',
  },
  Verification: {
    title: 'That link has expired or was already used',
    body: 'Sign-in links work once and stop working after a day. Request a new one below.',
  },
  Configuration: {
    title: 'Sign-in is not set up correctly',
    body: 'Something is wrong on the server side, not with what you entered. Try again later or tell whoever runs this instance.',
  },
  EmailSignin: {
    title: 'The sign-in email could not be sent',
    body: 'The mail server did not accept the message. Try again in a moment.',
  },
  EmailSignInError: {
    title: 'The sign-in email could not be sent',
    body: 'The mail server did not accept the message. Try again in a moment.',
  },
  OAuthSignin: {
    title: 'Could not start sign-in with that provider',
    body: 'The provider did not respond as expected. Try again, or use a sign-in link instead.',
  },
  OAuthSignInError: {
    title: 'Could not start sign-in with that provider',
    body: 'The provider did not respond as expected. Try again, or use a sign-in link instead.',
  },
  OAuthCallbackError: {
    title: 'The provider did not complete sign-in',
    body: 'The provider sent us back without a valid answer. Try again, or use a sign-in link instead.',
  },
  Callback: {
    title: 'The provider did not complete sign-in',
    body: 'The provider sent us back without a valid answer. Try again, or use a sign-in link instead.',
  },
  SessionRequired: {
    title: 'Sign in to continue',
    body: 'That page needs you to be signed in.',
  },
  InvalidEmail: {
    title: 'That does not look like an email address',
    body: 'Check the address and try again.',
  },
};

const DEFAULT: AuthErrorMessage = {
  title: 'Sign-in did not work',
  body: 'Something went wrong. Try again; if it keeps happening, tell whoever runs this instance.',
};

/** Wording for a code, or null when there is no code at all. Unknown codes get the default. */
export function authErrorMessage(code: string | undefined): AuthErrorMessage | null {
  if (!code) return null;
  return MESSAGES[code] ?? DEFAULT;
}
