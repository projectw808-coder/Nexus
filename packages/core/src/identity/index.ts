export {
  normalizeEmail,
  normalizePhone,
  phonesMatch,
  normalizeHandle,
  normalizeName,
  domainOfEmail,
  domainOfUrl,
  normalizeProfileUrl,
  urlsInText,
  trigramSimilarity,
} from './normalize.ts';
export {
  scorePair,
  combine,
  subjectBuilder,
  emptySubject,
  platformLabel,
  AUTO_THRESHOLD,
  SUGGEST_THRESHOLD,
  NAME_SIMILARITY_MIN,
} from './score.ts';
export type {
  MatchSubject,
  Signal,
  SignalKind,
  SignalTier,
  PairScore,
  LinkMethodName,
  ExternalRef,
  PlatformHandle,
} from './score.ts';
