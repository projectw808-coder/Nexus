/**
 * Typed Result. Every external call in Nexus returns one of these instead of throwing
 * (spec §0.3 "No silent failure"). `E` defaults to NexusError so callers always get a
 * machine code and a human remediation string.
 */
import type { NexusError } from './errors.ts';

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = NexusError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is Err<E> {
  return !r.ok;
}

/** Unwrap or throw the contained error. Use only at the very edge (a route handler, a CLI). */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- E is the caller-chosen error type
  throw r.error;
}

export function map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

/**
 * Run a thunk (sync or async) and capture a thrown value into an Err via `onThrow`,
 * which decides how unknown throwables become the typed error.
 */
export async function attempt<T, E>(
  thunk: () => Promise<T> | T,
  onThrow: (cause: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await thunk());
  } catch (cause) {
    return err(onThrow(cause));
  }
}
