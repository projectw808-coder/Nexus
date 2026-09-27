'use server';

import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { z } from 'zod';
import { createUserWithPassword } from '@nexus/db';
import {
  configuredProviders,
  CREDENTIALS_PROVIDER_ID,
  signIn,
  signOut,
  type OAuthProviderId,
} from '@/auth';
import { hashPassword } from '@/lib/password';
import { safeCallbackUrl } from './callback-url';

function signInUrl(params: Record<string, string>): string {
  return `/sign-in?${new URLSearchParams(params).toString()}`;
}

function createAccountUrl(params: Record<string, string>): string {
  return `/sign-in/create-account?${new URLSearchParams(params).toString()}`;
}

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export async function login(formData: FormData): Promise<void> {
  const callbackUrl = safeCallbackUrl(formData.get('callbackUrl'));
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) redirect(signInUrl({ error: 'CredentialsSignin', callbackUrl }));
  const { email, password } = parsed.data;

  try {
    await signIn(CREDENTIALS_PROVIDER_ID, {
      email: email.trim().toLowerCase(),
      password,
      redirectTo: callbackUrl,
      redirect: false,
    });
  } catch (e) {
    if (e instanceof AuthError) redirect(signInUrl({ error: e.type, callbackUrl }));
    throw e;
  }
  redirect(callbackUrl);
}

const createAccountSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().trim().max(120).optional(),
});

export async function createAccount(formData: FormData): Promise<void> {
  const callbackUrl = safeCallbackUrl(formData.get('callbackUrl'));
  const raw = {
    email: formData.get('email'),
    password: formData.get('password'),
    name: formData.get('name') || undefined,
  };
  const parsed = createAccountSchema.safeParse(raw);
  if (!parsed.success) {
    const tooShort = parsed.error.issues.some((i) => i.path[0] === 'password');
    redirect(createAccountUrl({ error: tooShort ? 'WeakPassword' : 'CredentialsSignin', callbackUrl }));
  }
  const { email, password, name } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    await createUserWithPassword({ email: normalizedEmail, passwordHash: await hashPassword(password), name });
  } catch (e) {
    // Prisma's unique-constraint violation on User.email.
    if (e instanceof Object && 'code' in e && e.code === 'P2002') {
      redirect(createAccountUrl({ error: 'EmailInUse', callbackUrl }));
    }
    throw e;
  }

  try {
    await signIn(CREDENTIALS_PROVIDER_ID, {
      email: normalizedEmail,
      password,
      redirectTo: callbackUrl,
      redirect: false,
    });
  } catch (e) {
    if (e instanceof AuthError) redirect(signInUrl({ error: e.type, callbackUrl }));
    throw e;
  }
  redirect(callbackUrl);
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
