/**
 * Signing for customer-facing outbound webhooks (§11.2 "signed with HMAC-SHA256, timestamped").
 *
 * The wire format is deliberately the interoperable one a customer already knows from Stripe and
 * GitHub, so integrating means reusing code they have probably written before:
 *
 *   X-Nexus-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
 *
 * where the HMAC is taken over the *exact* bytes `${t}.${rawBody}` with the subscription's
 * signing secret. The timestamp is inside the signed material, so it cannot be moved without
 * invalidating the signature, which is what makes a replay window enforceable.
 *
 * `verifySignature` is what a *customer* implements on their side; it lives here so the format is
 * proven verifiable by its own tests and so redelivery tests can assert a real signature.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Header carrying `t=`/`v1=`. */
export const SIGNATURE_HEADER = 'X-Nexus-Signature';
/** Header carrying the public event name, e.g. `record.created`. */
export const EVENT_HEADER = 'X-Nexus-Event';
/** Header carrying the `OutboundWebhookDelivery` id — the customer's idempotency key. */
export const DELIVERY_HEADER = 'X-Nexus-Delivery';
/** Header carrying the 1-based attempt number of this POST. */
export const ATTEMPT_HEADER = 'X-Nexus-Attempt';
/** Header carrying the subscription id, so a customer running several can tell them apart. */
export const SUBSCRIPTION_HEADER = 'X-Nexus-Subscription';

/** Default acceptance window for `t` on the receiving end. Five minutes, like Stripe's. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Prefix on the plaintext secret, so a leaked string is recognizable in a log or a paste. */
export const SECRET_PREFIX = 'whsec_';

/** A fresh signing secret: 32 CSPRNG bytes, base64url, prefixed. Never `Math.random`. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The v1 signature: hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function signPayload(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** The full `X-Nexus-Signature` value for one request. */
export function signatureHeaderValue(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${signPayload(secret, timestamp, rawBody)}`;
}

/** Constant-time hex compare that never throws on a malformed candidate. */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * The primitive a customer needs: does `signature` (a bare hex v1 value) match this body at this
 * timestamp? Tampering with either the body or the timestamp fails.
 */
export function verifySignature(
  secret: string,
  timestamp: number | string,
  rawBody: string,
  signature: string,
): boolean {
  return hexEquals(signPayload(secret, timestamp, rawBody), signature);
}

export type ParsedSignatureHeader = { timestamp: number; v1: string[] };

/** Parse `t=...,v1=...[,v1=...]` leniently; unknown schemes are ignored, not rejected. */
export function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === 'v1') v1.push(value);
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestamp, v1 };
}

/**
 * Full receiver-side check: parse the header, enforce the replay window, then compare. This is
 * the snippet the webhooks guide hands customers.
 */
export function verifySignatureHeader(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceSeconds?: number; now?: () => Date } = {},
): boolean {
  if (!header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
  if (tolerance > 0 && Math.abs(nowSeconds - parsed.timestamp) > tolerance) return false;
  const expected = signPayload(secret, parsed.timestamp, rawBody);
  return parsed.v1.some((candidate) => hexEquals(expected, candidate));
}
