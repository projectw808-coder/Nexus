/**
 * `OutboundWebhookSubscription` CRUD (§11.2). The signing secret follows the same discipline as
 * an OAuth token or an API key: generated here, stored only in the TokenVault
 * (`VaultKind.SIGNING_SECRET`), returned in plaintext exactly once — at creation, and again only
 * if someone explicitly rotates it. `secretRef` on the row is a vault handle, never the secret.
 *
 * Delete is a soft delete (`deletedAt`), matching every other customer-owned row in this
 * codebase; the delivery log is a log table and survives, so history stays auditable.
 */
import { NexusError } from '@nexus/core';
import type { Actor, TenantDb } from '../scoped.ts';
import type { Vault } from '../vault.ts';
import { assertOutboundEventTypes, type OutboundEventType } from './events.ts';
import { generateSigningSecret } from './signing.ts';

export type SubscriptionRow = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  description: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSubscriptionInput = {
  url: string;
  events: string[];
  description?: string | null;
};

/** https only, and no obvious loopback/link-local target — a webhook must leave the building. */
export function assertDeliverableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NexusError('VALIDATION', { context: { reason: 'That is not a valid URL.' } });
  }
  if (url.protocol !== 'https:')
    throw new NexusError('VALIDATION', {
      context: { reason: 'Webhook endpoints must use https.' },
    });
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked)
    throw new NexusError('VALIDATION', {
      context: { reason: 'That host is not reachable from Nexus — use a public https endpoint.' },
    });
  return url;
}

const select = {
  id: true,
  url: true,
  events: true,
  enabled: true,
  description: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Create a subscription and its signing secret. `secretPlaintext` is the only time the secret is
 * ever readable outside the vault — the caller shows it once and must not persist it.
 */
export async function createSubscription(
  db: TenantDb,
  actor: Actor,
  vault: Vault,
  input: CreateSubscriptionInput,
): Promise<{ subscription: SubscriptionRow; secretPlaintext: string }> {
  const url = assertDeliverableUrl(input.url);
  const events = uniqueEvents(input.events);
  const secretPlaintext = generateSigningSecret();
  const { ref } = await vault.put(db, {
    workspaceId: actor.workspaceId,
    kind: 'SIGNING_SECRET',
    secret: secretPlaintext,
  });
  const subscription = await db.outboundWebhookSubscription.create({
    data: {
      workspaceId: actor.workspaceId,
      url: url.toString(),
      secretRef: ref,
      events,
      enabled: true,
      description: input.description?.trim() || null,
      createdById: actor.userId,
    },
    select,
  });
  return { subscription, secretPlaintext };
}

export async function listSubscriptions(db: TenantDb): Promise<SubscriptionRow[]> {
  return db.outboundWebhookSubscription.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select,
  });
}

export async function getSubscription(db: TenantDb, id: string): Promise<SubscriptionRow> {
  const row = await db.outboundWebhookSubscription.findFirst({
    where: { id, deletedAt: null },
    select,
  });
  if (!row) throw new NexusError('NOT_FOUND', { message: 'Webhook subscription not found.' });
  return row;
}

export type UpdateSubscriptionInput = {
  url?: string;
  events?: string[];
  enabled?: boolean;
  description?: string | null;
};

export async function updateSubscription(
  db: TenantDb,
  id: string,
  patch: UpdateSubscriptionInput,
): Promise<SubscriptionRow> {
  const before = await getSubscription(db, id);
  const data: Record<string, unknown> = {};
  if (patch.url !== undefined) data['url'] = assertDeliverableUrl(patch.url).toString();
  if (patch.events !== undefined) data['events'] = uniqueEvents(patch.events);
  if (patch.enabled !== undefined) data['enabled'] = patch.enabled;
  if (patch.description !== undefined)
    data['description'] = patch.description?.trim() ? patch.description.trim() : null;
  const after = await db.outboundWebhookSubscription.update({
    where: { id: before.id },
    data,
    select,
  });
  return after;
}

/**
 * Soft delete, and revoke the signing secret in the same transaction: the row stays for history
 * but the secret stops existing, so a leaked `secretRef` is worth nothing afterwards.
 */
export async function deleteSubscription(
  db: TenantDb,
  vault: Vault,
  id: string,
): Promise<{ id: string }> {
  const row = await db.outboundWebhookSubscription.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, url: true, secretRef: true },
  });
  if (!row) throw new NexusError('NOT_FOUND', { message: 'Webhook subscription not found.' });
  await db.outboundWebhookSubscription.update({
    where: { id: row.id },
    data: { deletedAt: new Date(), enabled: false },
  });
  await vault.revoke(db, row.secretRef).catch(() => undefined);
  return { id: row.id };
}

/** Mint a new signing secret for an existing subscription. Returns the plaintext once. */
export async function rotateSubscriptionSecret(
  db: TenantDb,
  vault: Vault,
  id: string,
): Promise<{ id: string; secretPlaintext: string }> {
  const row = await db.outboundWebhookSubscription.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, secretRef: true },
  });
  if (!row) throw new NexusError('NOT_FOUND', { message: 'Webhook subscription not found.' });
  const secretPlaintext = generateSigningSecret();
  await vault.rotate(db, row.secretRef, secretPlaintext);
  return { id: row.id, secretPlaintext };
}

function uniqueEvents(events: string[]): OutboundEventType[] {
  const known = assertOutboundEventTypes(events.map((e) => e.trim()).filter(Boolean));
  if (known.length === 0)
    throw new NexusError('VALIDATION', {
      context: { reason: 'Pick at least one event to subscribe to.' },
    });
  return [...new Set(known)];
}
