/** Client-safe platform labels (mirrors PLATFORM_LABELS in the SDK without importing it). */
export const PLATFORM_NAME: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  GMAIL: 'Gmail',
  GOOGLE_CALENDAR: 'Google Calendar',
  GOOGLE_BUSINESS: 'Google Business',
  KEITARO: 'Keitaro',
  MOCK: 'Mock',
};

export const PLATFORM_SHORT: Record<string, string> = {
  FACEBOOK: 'FB',
  INSTAGRAM: 'IG',
  X: 'X',
  LINKEDIN: 'LI',
  TIKTOK: 'TT',
  YOUTUBE: 'YT',
  GMAIL: 'GM',
  GOOGLE_CALENDAR: 'GC',
  GOOGLE_BUSINESS: 'GB',
  KEITARO: 'KT',
  MOCK: 'MK',
};

/** One-line explanation shown on the "Add a connection" card for each platform. */
export const PLATFORM_DESCRIPTION: Record<string, string> = {
  FACEBOOK: 'Sync Page messages, comments and lead ads into your inbox.',
  INSTAGRAM: 'Bring DMs, comments and story mentions into your inbox.',
  X: 'Track mentions, replies and DMs from your X account.',
  LINKEDIN: 'Sync organization posts, comments and Lead Gen Form leads.',
  TIKTOK: 'Import comments and lead events from your TikTok account.',
  YOUTUBE: 'Sync comments and video engagement from your channel.',
  GMAIL: 'Two-way sync of email threads with your clients.',
  GOOGLE_CALENDAR: 'Sync meetings and events tied to your clients.',
  GOOGLE_BUSINESS: 'Track reviews and messages from your Business Profile.',
  KEITARO: 'Pull click and conversion tracking data from your campaigns.',
  MOCK: 'A sandbox platform for testing syncs without a real account.',
};

export function platformName(p: string | null | undefined): string {
  return p ? (PLATFORM_NAME[p] ?? p) : '';
}

export function platformDescription(p: string | null | undefined): string {
  return p ? (PLATFORM_DESCRIPTION[p] ?? '') : '';
}

export function platformShort(p: string | null | undefined): string {
  return p ? (PLATFORM_SHORT[p] ?? p.slice(0, 2)) : '';
}

export const TIMELINE_TYPE_LABEL: Record<string, string> = {
  MESSAGE: 'Message',
  COMMENT: 'Comment',
  MENTION: 'Mention',
  POST_ENGAGEMENT: 'Engagement',
  LEAD_FORM: 'Lead form',
  EMAIL: 'E-mail',
  MEETING: 'Meeting',
  CALL: 'Call',
  NOTE: 'Note',
  TASK: 'Task',
  STAGE_CHANGE: 'Stage',
  FIELD_CHANGE: 'Field',
  DEAL_EVENT: 'Deal',
  AI_INSIGHT: 'Insight',
  SYSTEM: 'System',
};

export const LINK_METHOD_LABEL: Record<string, string> = {
  EXACT_EMAIL: 'same e-mail',
  PHONE: 'same phone',
  OAUTH_SELF: 'connected by the person',
  DOMAIN: 'company domain and name',
  NAME_FUZZY: 'similar name',
  HANDLE_MATCH: 'matching handle',
  MANUAL: 'linked by a teammate',
  AI_INFERRED: 'inferred',
  PLATFORM_PROVIDED: 'reported by the platform',
};

/** A link's label for a person: display name, else @handle, else the platform id. */
export function identityLabel(i: {
  displayName: string | null;
  handle: string | null;
  externalId: string;
}): string {
  return i.displayName ?? (i.handle ? `@${i.handle}` : i.externalId);
}
