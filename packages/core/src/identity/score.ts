/**
 * Tiered identity scoring (spec §10): deterministic first, probabilistic second, human always
 * able to override. Pure — the resolver in `packages/db` builds `MatchSubject`s from rows and
 * this module turns a pair into a score, the verbatim signals behind it (rendered in the "why
 * are these the same person?" panel) and the decision the policy allows.
 *
 * Tier 1 (1.0, auto-merge): verified e-mail · phone · platform-provided linkage.
 * Tier 2 (0.7–0.95): identical handle on another platform plus a corroborating signal ·
 *   same company domain + same display name · a bio link resolving to a known profile URL.
 * Tier 3 (0.4–0.7, suggest only): fuzzy name (trigram ≥ 0.85) + same locale/timezone · fuzzy
 *   name alone · handle alone. Avatar perceptual hashes and bio embeddings are not computed
 *   yet (no media pipeline before Phase 9, no AI layer before Phase 10) — see ADR-017.
 *
 * Auto-merge only at ≥ 0.9 AND (≥ 1 Tier-1 signal OR ≥ 2 Tier-2 signals). Otherwise ≥ 0.4
 * becomes a suggestion; below that, nothing.
 */
import {
  domainOfEmail,
  domainOfUrl,
  normalizeEmail,
  normalizeHandle,
  normalizeName,
  normalizePhone,
  normalizeProfileUrl,
  phonesMatch,
  trigramSimilarity,
  urlsInText,
} from './normalize.ts';

export type ExternalRef = { platform: string; externalId: string };
export type PlatformHandle = { platform: string; handle: string };

/** Everything the scorer compares, already normalised. Build with `subjectBuilder()`. */
export type MatchSubject = {
  kind: 'record' | 'identity';
  id: string;
  /** For the evidence panel. */
  label: string;
  emails: string[];
  phones: string[];
  handles: PlatformHandle[];
  names: string[];
  domains: string[];
  profileUrls: string[];
  bioUrls: string[];
  locales: string[];
  timezones: string[];
  /** The subject's own platform ids. */
  externalIds: ExternalRef[];
  /** Ids the platform says belong to the same person (Meta's linked IG ↔ Page, Google account). */
  linkedExternalIds: ExternalRef[];
};

export type SignalTier = 1 | 2 | 3;

export type SignalKind =
  | 'EXACT_EMAIL'
  | 'PHONE'
  | 'PLATFORM_PROVIDED'
  | 'HANDLE_MATCH'
  | 'DOMAIN_NAME'
  | 'BIO_LINK'
  | 'NAME_FUZZY'
  | 'NAME_FUZZY_LOCALE'
  | 'HANDLE_ONLY';

/** The `LinkMethod` enum in the schema, kept as strings so core stays free of the db package. */
export type LinkMethodName =
  | 'EXACT_EMAIL'
  | 'PHONE'
  | 'OAUTH_SELF'
  | 'DOMAIN'
  | 'NAME_FUZZY'
  | 'HANDLE_MATCH'
  | 'MANUAL'
  | 'AI_INFERRED'
  | 'PLATFORM_PROVIDED';

export type Signal = {
  kind: SignalKind;
  tier: SignalTier;
  /** Contribution to the noisy-or score. */
  weight: number;
  method: LinkMethodName;
  /** One sentence for the panel. */
  label: string;
  /** The values, verbatim, on each side. */
  left: unknown;
  right: unknown;
};

export type PairScore = {
  score: number;
  signals: Signal[];
  tier1: number;
  tier2: number;
  tier3: number;
  decision: 'auto' | 'suggest' | 'none';
  /** The strongest signal's method — what an automatic link is recorded as. */
  method: LinkMethodName;
};

export const AUTO_THRESHOLD = 0.9;
export const SUGGEST_THRESHOLD = 0.4;
export const NAME_SIMILARITY_MIN = 0.85;

export function emptySubject(kind: MatchSubject['kind'], id: string, label: string): MatchSubject {
  return {
    kind,
    id,
    label,
    emails: [],
    phones: [],
    handles: [],
    names: [],
    domains: [],
    profileUrls: [],
    bioUrls: [],
    locales: [],
    timezones: [],
    externalIds: [],
    linkedExternalIds: [],
  };
}

/** Accumulates raw values into a normalised, de-duplicated `MatchSubject`. */
export function subjectBuilder(kind: MatchSubject['kind'], id: string, label: string) {
  const s = emptySubject(kind, id, label);
  const push = (arr: string[], v: string | null) => {
    if (v && !arr.includes(v)) arr.push(v);
  };
  const api = {
    email(v: string | null | undefined) {
      const e = normalizeEmail(v);
      push(s.emails, e);
      push(s.domains, domainOfEmail(e));
      return api;
    },
    phone(v: string | null | undefined) {
      push(s.phones, normalizePhone(v));
      return api;
    },
    handle(platform: string, v: string | null | undefined) {
      const h = normalizeHandle(v);
      if (h && !s.handles.some((x) => x.platform === platform && x.handle === h))
        s.handles.push({ platform, handle: h });
      return api;
    },
    name(v: string | null | undefined) {
      push(s.names, normalizeName(v));
      return api;
    },
    domain(v: string | null | undefined) {
      push(s.domains, domainOfUrl(v) ?? (v ? v.trim().toLowerCase() : null));
      return api;
    },
    profileUrl(v: string | null | undefined) {
      push(s.profileUrls, normalizeProfileUrl(v));
      return api;
    },
    bio(v: string | null | undefined) {
      for (const u of urlsInText(v)) push(s.bioUrls, normalizeProfileUrl(u));
      return api;
    },
    bioUrl(v: string | null | undefined) {
      push(s.bioUrls, normalizeProfileUrl(v));
      return api;
    },
    locale(v: string | null | undefined) {
      push(s.locales, v ? v.trim().toLowerCase().replace('_', '-') : null);
      return api;
    },
    timezone(v: string | null | undefined) {
      push(s.timezones, v ? v.trim() : null);
      return api;
    },
    externalId(platform: string, externalId: string | null | undefined) {
      if (
        externalId &&
        !s.externalIds.some((x) => x.platform === platform && x.externalId === externalId)
      )
        s.externalIds.push({ platform, externalId });
      return api;
    },
    linked(platform: string, externalId: string | null | undefined) {
      if (
        externalId &&
        !s.linkedExternalIds.some((x) => x.platform === platform && x.externalId === externalId)
      )
        s.linkedExternalIds.push({ platform, externalId });
      return api;
    },
    build(): MatchSubject {
      return s;
    },
  };
  return api;
}

function shared<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [T, T][] {
  const out: [T, T][] = [];
  for (const x of a) for (const y of b) if (eq(x, y)) out.push([x, y]);
  return out;
}

function sameRef(x: ExternalRef, y: ExternalRef): boolean {
  return x.platform === y.platform && x.externalId === y.externalId;
}

/** Score one pair. Symmetric: `scorePair(a, b)` and `scorePair(b, a)` agree on score and decision. */
export function scorePair(left: MatchSubject, right: MatchSubject): PairScore {
  const signals: Signal[] = [];

  // ── Tier 1 ────────────────────────────────────────────────────────────────
  for (const [l, r] of shared(left.emails, right.emails, (x, y) => x === y))
    signals.push({
      kind: 'EXACT_EMAIL',
      tier: 1,
      weight: 1,
      method: 'EXACT_EMAIL',
      label: `Both have the e-mail ${l}`,
      left: l,
      right: r,
    });
  for (const [l, r] of shared(left.phones, right.phones, phonesMatch))
    signals.push({
      kind: 'PHONE',
      tier: 1,
      weight: 1,
      method: 'PHONE',
      label: `Both have the phone number ${r}`,
      left: l,
      right: r,
    });
  const linkage = [
    ...shared(left.externalIds, right.externalIds, sameRef),
    ...shared(left.linkedExternalIds, right.externalIds, sameRef),
    ...shared(left.externalIds, right.linkedExternalIds, sameRef),
    ...shared(left.linkedExternalIds, right.linkedExternalIds, sameRef),
  ];
  for (const [l, r] of linkage)
    signals.push({
      kind: 'PLATFORM_PROVIDED',
      tier: 1,
      weight: 1,
      method: 'PLATFORM_PROVIDED',
      label: `${platformLabel(r.platform)} reports the same account (${r.externalId})`,
      left: l,
      right: r,
    });

  // ── Corroboration used by Tier 2 ──────────────────────────────────────────
  const sameName = shared(left.names, right.names, (x, y) => x === y);
  const bioLinks = [
    ...shared(left.bioUrls, right.profileUrls, (x, y) => x === y),
    ...shared(left.profileUrls, right.bioUrls, (x, y) => x === y),
  ];

  // ── Tier 2 ────────────────────────────────────────────────────────────────
  const handleHits = shared(left.handles, right.handles, (x, y) => x.handle === y.handle);
  for (const [l, r] of handleHits) {
    const corroboration = sameName[0]
      ? `the display name "${sameName[0][0]}"`
      : bioLinks[0]
        ? `a bio link to ${bioLinks[0][1]}`
        : null;
    if (corroboration)
      signals.push({
        kind: 'HANDLE_MATCH',
        tier: 2,
        weight: 0.85,
        method: 'HANDLE_MATCH',
        label: `Same handle @${r.handle} on ${platformLabel(l.platform)} and ${platformLabel(r.platform)}, corroborated by ${corroboration}`,
        left: l,
        right: r,
      });
    else
      signals.push({
        kind: 'HANDLE_ONLY',
        tier: 3,
        weight: 0.5,
        method: 'HANDLE_MATCH',
        label: `Same handle @${r.handle} on ${platformLabel(l.platform)} and ${platformLabel(r.platform)}, nothing else corroborates it`,
        left: l,
        right: r,
      });
  }
  const sameDomain = shared(left.domains, right.domains, (x, y) => x === y);
  if (sameDomain[0] && sameName[0])
    signals.push({
      kind: 'DOMAIN_NAME',
      tier: 2,
      weight: 0.8,
      method: 'DOMAIN',
      label: `Same company domain ${sameDomain[0][0]} and the same name "${sameName[0][0]}"`,
      left: { domain: sameDomain[0][0], name: sameName[0][0] },
      right: { domain: sameDomain[0][1], name: sameName[0][1] },
    });
  for (const [l, r] of bioLinks)
    signals.push({
      kind: 'BIO_LINK',
      tier: 2,
      weight: 0.9,
      method: 'HANDLE_MATCH',
      label: `A bio link points at the known profile ${r}`,
      left: l,
      right: r,
    });

  // ── Tier 3 ────────────────────────────────────────────────────────────────
  if (sameName.length === 0) {
    let best: { l: string; r: string; sim: number } | null = null;
    for (const l of left.names)
      for (const r of right.names) {
        const sim = trigramSimilarity(l, r);
        if (sim >= NAME_SIMILARITY_MIN && (!best || sim > best.sim)) best = { l, r, sim };
      }
    if (best) {
      const locale = shared(left.locales, right.locales, (x, y) => x === y)[0];
      const tz = shared(left.timezones, right.timezones, (x, y) => x === y)[0];
      const corroborated = locale ?? tz;
      signals.push({
        kind: corroborated ? 'NAME_FUZZY_LOCALE' : 'NAME_FUZZY',
        tier: 3,
        weight: corroborated ? 0.6 : 0.4,
        method: 'NAME_FUZZY',
        label: corroborated
          ? `Names "${best.l}" and "${best.r}" are ${Math.round(best.sim * 100)}% similar and both are in ${corroborated[0]}`
          : `Names "${best.l}" and "${best.r}" are ${Math.round(best.sim * 100)}% similar`,
        left: {
          name: best.l,
          similarity: best.sim,
          locale: locale?.[0] ?? null,
          timezone: tz?.[0] ?? null,
        },
        right: {
          name: best.r,
          similarity: best.sim,
          locale: locale?.[1] ?? null,
          timezone: tz?.[1] ?? null,
        },
      });
    }
  } else if (signals.every((s) => s.tier === 3)) {
    // Identical names with nothing stronger: worth a suggestion, never a merge.
    const locale = shared(left.locales, right.locales, (x, y) => x === y)[0];
    const tz = shared(left.timezones, right.timezones, (x, y) => x === y)[0];
    const corroborated = locale ?? tz;
    signals.push({
      kind: corroborated ? 'NAME_FUZZY_LOCALE' : 'NAME_FUZZY',
      tier: 3,
      weight: corroborated ? 0.6 : 0.4,
      method: 'NAME_FUZZY',
      label: corroborated
        ? `Identical name "${sameName[0]![0]}" and both are in ${corroborated[0]}`
        : `Identical name "${sameName[0]![0]}"`,
      left: { name: sameName[0]![0], similarity: 1 },
      right: { name: sameName[0]![1], similarity: 1 },
    });
  }

  return combine(signals);
}

export function combine(signals: Signal[]): PairScore {
  const tier1 = signals.filter((s) => s.tier === 1).length;
  const tier2 = signals.filter((s) => s.tier === 2).length;
  const tier3 = signals.filter((s) => s.tier === 3).length;
  let score = 0;
  if (tier1 > 0) score = 1;
  else {
    let miss = 1;
    for (const s of signals) miss *= 1 - s.weight;
    score = Math.round((1 - miss) * 1000) / 1000;
  }
  const decision =
    score >= AUTO_THRESHOLD && (tier1 >= 1 || tier2 >= 2)
      ? 'auto'
      : score >= SUGGEST_THRESHOLD
        ? 'suggest'
        : 'none';
  const strongest = [...signals].sort((a, b) => a.tier - b.tier || b.weight - a.weight)[0];
  return {
    score,
    signals,
    tier1,
    tier2,
    tier3,
    decision,
    method: strongest?.method ?? 'AI_INFERRED',
  };
}

const PLATFORM_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  GOOGLE: 'Google',
  KEITARO: 'Keitaro',
  MOCK: 'Mock platform',
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}
