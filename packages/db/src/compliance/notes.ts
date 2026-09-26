/**
 * `PlatformComplianceNote` (§5.5): the platform's own terms constraints, per connector, surfaced
 * in the admin UI. Global (no `workspaceId`) and operator-maintained — a constraint of Meta's
 * Platform Terms is a fact about Meta, not about one customer.
 *
 * Every note below is carried over from this repo's own connector capability sheets
 * (`docs/connectors/*.md`) and connector manifests (`manifest.constraints`), which are where the
 * constraints were recorded when each connector was built in Phases 5–8. Nothing here is
 * invented, and `sourceUrl` is the platform documentation root the manifest itself cites
 * (`manifest.docsUrl`) — not a deep link someone might have guessed. Where the underlying figure
 * is provenance-flagged in our own docs (TikTok's 48-hour window), the note says so rather than
 * presenting it as a confirmed platform guarantee.
 */
import type { Platform } from '../generated/prisma/enums.ts';
import type { SystemDb, TenantDb, TenantRuntime } from '../scoped.ts';

/** A note as the admin UI renders it. */
export type ComplianceNoteRow = {
  id: string;
  platform: Platform;
  key: string;
  title: string;
  body: string;
  sourceUrl: string | null;
  effectiveFrom: Date | null;
  updatedAt: Date;
};

export type ComplianceNoteSeed = {
  platform: Platform;
  key: string;
  title: string;
  body: string;
  sourceUrl: string | null;
};

const META_DOCS = 'https://developers.facebook.com/docs/graph-api/';
const X_DOCS = 'https://developer.x.com/en/docs/x-api';
const LINKEDIN_DOCS =
  'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/marketing-integrations-overview';
const TIKTOK_DOCS = 'https://developers.tiktok.com/';
const YOUTUBE_DOCS = 'https://developers.google.com/youtube/v3/docs';
const KEITARO_DOCS = 'https://docs.keitaro.io/';

export const PLATFORM_COMPLIANCE_NOTES: readonly ComplianceNoteSeed[] = [
  {
    platform: 'FACEBOOK',
    key: 'messaging_window',
    title: '24-hour standard messaging window',
    body:
      "Standard messaging must be sent within 24 hours of the customer's last message; outside " +
      'that window Meta permits only tagged messages. This connector never sends tagged ' +
      'messages, so preflight blocks a reply outside the window and tells the agent when the ' +
      "window reopens (the customer's next message). Source: docs/connectors/meta.md " +
      '“Messaging window”.',
    sourceUrl: META_DOCS,
  },
  {
    platform: 'FACEBOOK',
    key: 'advanced_access_review',
    title: 'Advanced Access needs App Review and Business Verification',
    body:
      'Advanced access to the messaging, engagement, comments, insights and leads scopes requires ' +
      'App Review plus Business Verification. Until both are granted, only accounts with a role ' +
      'on the app return data — a connection can look healthy and still see nothing. Source: ' +
      'docs/connectors/meta.md “Scopes”, manifest.tierNotes.',
    sourceUrl: META_DOCS,
  },
  {
    platform: 'FACEBOOK',
    key: 'version_deprecation',
    title: 'Expired API versions are served silently from an older version',
    body:
      'A call to an expired Graph API version is not rejected — Meta serves it from the ' +
      'next-oldest live version, so a stale pinned version degrades quietly rather than failing. ' +
      'The served version is asserted on every response and drift raises SCHEMA_DRIFT. Source: ' +
      'docs/connectors/meta.md “Version-drift monitor”.',
    sourceUrl: META_DOCS,
  },
  {
    platform: 'INSTAGRAM',
    key: 'messaging_window',
    title: '24-hour standard messaging window',
    body:
      'Instagram messaging goes through the same Meta rule as Pages: replies must be sent within ' +
      "24 hours of the customer's last message, and this connector does not send tagged messages " +
      'outside it. Source: docs/connectors/meta.md “Messaging window”.',
    sourceUrl: META_DOCS,
  },
  {
    platform: 'INSTAGRAM',
    key: 'app_level_webhook_subscription',
    title: 'Instagram webhooks are subscribed at the app level',
    body:
      'Instagram webhook topics are subscribed once per app in the Meta dashboard, not per ' +
      'connection; Page fields are subscribed per Page on connect. An operator adding a new ' +
      'Instagram account still depends on the app-level subscription being in place. Source: ' +
      'docs/connectors/meta.md “Webhooks”, manifest.constraints.',
    sourceUrl: META_DOCS,
  },
  {
    platform: 'X',
    key: 'deletion_tombstones',
    title: 'Deletions must propagate — stored copies cannot outlive the post',
    body:
      'Deleted posts and DMs are honoured as tombstones (isDeleted: true) and never dropped from ' +
      'the sync, so a deletion on X reaches the copy held here instead of leaving a stale record ' +
      'behind. Source: docs/connectors/x.md, manifest.constraints.',
    sourceUrl: X_DOCS,
  },
  {
    platform: 'X',
    key: 'metered_spend_cap',
    title: 'Metered API: a spend cap is required before any billable call',
    body:
      'X bills per call, and a URL-bearing DM reply costs 13x a plain one ($0.20 vs $0.015). A ' +
      'monthly spend cap (ConnectionSettings.spendCap) must be set on the connection before any ' +
      'metered call is made. The rate-card figures in our capability sheet are carried from the ' +
      "product spec and are NOT confirmed against X's live developer portal — re-verify before " +
      'relying on them. Source: docs/connectors/x.md §8, §15.',
    sourceUrl: X_DOCS,
  },
  {
    platform: 'LINKEDIN',
    key: 'marketing_api_approval',
    title: 'Community Management and Lead Sync need Marketing Developer Platform approval',
    body:
      "Organization content and Lead Sync require an approved application to LinkedIn's Marketing " +
      'Developer Platform. Until approval is granted the connection still connects with ' +
      'member-only identity and read:posts / read:comments / read:leads stay degraded — “not yet ' +
      'approved” is a connection state, not an error. Source: docs/connectors/linkedin.md §4, ' +
      'manifest.tierNotes.',
    sourceUrl: LINKEDIN_DOCS,
  },
  {
    platform: 'LINKEDIN',
    key: 'retired_scopes',
    title: 'r_liteprofile and r_emailaddress were retired and must never be requested',
    body:
      'Both scopes were retired in 2023; requesting them fails authorization. Member identity ' +
      'uses openid / profile / email instead. Source: docs/connectors/linkedin.md §4, ' +
      'manifest.constraints.',
    sourceUrl: LINKEDIN_DOCS,
  },
  {
    platform: 'LINKEDIN',
    key: 'no_member_dms',
    title: 'Member-to-member DMs are not available on this API',
    body:
      'There is no LinkedIn DM capability to sell or promise: this connector is read-only, ' +
      'preflight refuses every outbound action kind with POLICY_BLOCKED, and no conversation ' +
      'resource is modelled. Source: docs/connectors/linkedin.md §9, manifest.constraints.',
    sourceUrl: LINKEDIN_DOCS,
  },
  {
    platform: 'TIKTOK',
    key: 'retention_expectations',
    title: 'Stricter data-retention expectations than other platforms',
    body:
      "TikTok's data-retention expectations are stricter than most platforms', so new TikTok " +
      'connections should be created with a lower Connection.retentionDays than the ' +
      'workspace-wide default. This is connect-flow guidance recorded in our own manifest — the ' +
      'manifest does not itself enforce a ceiling, and the nightly retention purge only enforces ' +
      'whatever retentionDays the connection actually carries. Source: docs/connectors/tiktok.md ' +
      '§12, manifest.constraints.',
    sourceUrl: TIKTOK_DOCS,
  },
  {
    platform: 'TIKTOK',
    key: 'messaging_window_provenance',
    title: '48-hour messaging window — figure not confirmed by TikTok',
    body:
      'Business Messaging replies are gated on a 48-hour window from the customer’s last inbound ' +
      'message. The 48-hour figure comes from third-party integrator documentation (SleekFlow, ' +
      "Respond.io), NOT from TikTok's own developer docs, which were not accessible when this " +
      'connector was built. Re-verify against official TikTok Business Messaging documentation ' +
      'before relying on it in production. Source: docs/connectors/tiktok.md §9, §13.',
    sourceUrl: TIKTOK_DOCS,
  },
  {
    platform: 'YOUTUBE',
    key: 'no_platform_retention_ceiling',
    title: 'No YouTube-specific retention ceiling is documented',
    body:
      'Unlike TikTok and Keitaro, our capability sheet records no YouTube-specific reason to ' +
      'shorten retention or backfill depth, so a YouTube connection follows whatever ' +
      'Connection.retentionDays the workspace sets (or none). Source: docs/connectors/youtube.md ' +
      '§12.',
    sourceUrl: YOUTUBE_DOCS,
  },
  {
    platform: 'YOUTUBE',
    key: 'search_list_banned',
    title: 'search.list is banned from routine sync paths',
    body:
      'search.list sits in its own 100-calls/day cap, separate from the 10,000-unit daily pool, ' +
      "and is never used for discovery — playlistItems.list on the channel's uploads playlist is " +
      'used instead. The daily pool resets at midnight Pacific. Source: ' +
      'docs/connectors/youtube.md §8, manifest.constraints.',
    sourceUrl: YOUTUBE_DOCS,
  },
  {
    platform: 'KEITARO',
    key: 'click_level_personal_data',
    title: 'Click-level data is personal data in the EU/UK — keep retention low',
    body:
      'Click rows are personal data under EU/UK law, so Keitaro connections should default to a ' +
      'low Connection.retentionDays. Clicks are off by default (clickFilter.convertedOnly) and ' +
      'are never fully backfilled. Source: docs/connectors/keitaro.md §12.',
    sourceUrl: KEITARO_DOCS,
  },
  {
    platform: 'KEITARO',
    key: 'subid_pii_mapping',
    title: 'Conversions carry no PII unless a sub_id is mapped to one',
    body:
      'A Keitaro conversion holds no email, phone or external id by default — it becomes personal ' +
      'data only when an operator maps a sub_id to one in the connection settings. Unmapped ' +
      'clicks stay an anonymous Identity. Source: docs/connectors/keitaro.md §12, ' +
      'manifest.constraints.',
    sourceUrl: KEITARO_DOCS,
  },
];

/**
 * Upsert the operator-maintained notes. Idempotent on `(platform, key)`, so running it again
 * after editing the text above updates in place rather than duplicating. Global table, so this
 * goes through `withSystem` — there is no workspace to scope it to.
 */
export async function seedPlatformComplianceNotes(
  runtime: TenantRuntime,
  notes: readonly ComplianceNoteSeed[] = PLATFORM_COMPLIANCE_NOTES,
): Promise<{ created: number; updated: number }> {
  return runtime.withSystem(async (s) => upsertNotes(s, notes));
}

async function upsertNotes(
  s: SystemDb,
  notes: readonly ComplianceNoteSeed[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const note of notes) {
    const existing = await s.platformComplianceNote.findFirst({
      where: { platform: note.platform, key: note.key },
      select: { id: true },
    });
    if (existing) {
      await s.platformComplianceNote.update({
        where: { id: existing.id },
        data: {
          title: note.title,
          body: note.body,
          sourceUrl: note.sourceUrl,
          deletedAt: null,
        },
      });
      updated += 1;
    } else {
      await s.platformComplianceNote.create({
        data: {
          platform: note.platform,
          key: note.key,
          title: note.title,
          body: note.body,
          sourceUrl: note.sourceUrl,
        },
      });
      created += 1;
    }
  }
  return { created, updated };
}

/**
 * Notes for a set of platforms (in practice: the ones this workspace actually has a connection
 * for). `PlatformComplianceNote` has no `workspaceId`, so the scoped client passes it through
 * untouched — the caller decides which platforms are relevant.
 */
export async function listComplianceNotes(
  db: TenantDb,
  platforms?: readonly Platform[],
): Promise<ComplianceNoteRow[]> {
  return db.platformComplianceNote.findMany({
    where: {
      deletedAt: null,
      ...(platforms ? { platform: { in: [...platforms] } } : {}),
    },
    orderBy: [{ platform: 'asc' }, { key: 'asc' }],
    select: {
      id: true,
      platform: true,
      key: true,
      title: true,
      body: true,
      sourceUrl: true,
      effectiveFrom: true,
      updatedAt: true,
    },
  });
}
