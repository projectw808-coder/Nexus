/**
 * PII redaction before any external model call (spec §13, configurable per workspace). Regex, not
 * NER: the point is that an obvious identifier never leaves the building, not that redaction is
 * perfect. Every feature function runs user-authored free text (message bodies, note bodies,
 * record values) through this before it reaches a prompt.
 */
export type PiiRedactionLevel = 'strict' | 'standard' | 'off';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** +1 (555) 123-4567 · 555-123-4567 · +44 20 7946 0958 — seven or more digits with separators. */
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{5,}\d(?![\w.])/g;
/** 13–19 digits in groups: the shape of a payment card number. */
const CARD = /(?<![\w.])(?:\d[ -]?){12,18}\d(?![\w.])/g;
const SSN = /(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g;
const STREET =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Terrace|Ter|Place|Pl|Square|Sq|Highway|Hwy)\b\.?/gi;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function digitsIn(s: string): number {
  let n = 0;
  for (const c of s) if (c >= '0' && c <= '9') n++;
  return n;
}

/** A phone number has at least seven digits and is not an ISO date or a bare year range. */
function maybePhone(match: string): string {
  if (ISO_DATE.test(match)) return match;
  return digitsIn(match) >= 7 ? '[REDACTED_PHONE]' : match;
}

function maybeCard(match: string): string {
  const n = digitsIn(match);
  return n >= 13 && n <= 19 ? '[REDACTED_CARD]' : match;
}

export function redactPii(text: string, level: PiiRedactionLevel): string {
  if (level === 'off' || !text) return text;
  let out = text.replace(EMAIL, '[REDACTED_EMAIL]');
  if (level === 'strict') {
    // Order matters: SSN and card shapes overlap the phone shape, so claim them first.
    out = out.replace(SSN, '[REDACTED_SSN]');
    out = out.replace(CARD, maybeCard);
    out = out.replace(STREET, '[REDACTED_ADDRESS]');
  }
  out = out.replace(PHONE, maybePhone);
  return out;
}
