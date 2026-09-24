'use server';

import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { z } from 'zod';
import {
  configuredProviders,
  EMAIL_PROVIDER_ID,
  signIn,
  signOut,
  type OAuthProviderId,
} from '@/auth';
import { safeCallbackUrl } from './callback-url';

function signInUrl(params: Record<string, string>): string {
  return `/sign-in?${new URLSearchParams(params).toString()}`;
}

/**
 * Sends a magic link. On success the user lands on the "check your inbox" page with the address
 * they typed; on failure they return to the form with an `error` code the page can explain.
 */
export async function sendMagicLink(formData: FormData): Promise<void> {
  const callbackUrl = safeCallbackUrl(formData.get('callbackUrl'));
  const raw = formData.get('email');
  const parsed = z.email().safeParse(typeof raw === 'string' ? raw.trim() : '');
  if (!parsed.success) redirect(signInUrl({ error: 'InvalidEmail', callbackUrl }));
  const email = parsed.data.toLowerCase();

  try {
    // `redirect: false` — Auth.js's own success redirect would drop the address we want to echo.
    await signIn(EMAIL_PROVIDER_ID, { email, redirectTo: callbackUrl, redirect: false });
  } catch (e) {
    if (e instanceof AuthError) redirect(signInUrl({ error: e.type, callbackUrl }));
    throw e;
  }
  redirect(`/sign-in/check-email?${new URLSearchParams({ email }).toString()}`);
}

/** Starts an OAuth sign-in. Bound with the provider id and callback URL by the page. */
export async function signInWithProvider(
  providerId: OAuthProviderId,
  callbackUrl: string,
): Promise<void> {
  const safe = safeCallbackUrl(callbackUrl);
  if (!configuredProviders().includes(providerId)) {
    redirect(signInUrl({ error: 'Configuration', callbackUrl: safe }));
  }
  try {
    await signIn(providerId, { redirectTo: safe });
  } catch (e) {
    if (e instanceof AuthError) redirect(signInUrl({ error: e.type, callbackUrl: safe }));
    throw e; // includes Next's own redirect signal on success
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/sign-in' });
}
