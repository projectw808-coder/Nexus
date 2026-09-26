/**
 * Small, hand-rolled word lists for demo data (Appendix B) — no faker dependency. Deterministic
 * given a seeded PRNG so `pnpm db:seed --demo` produces the same-shaped data on every run,
 * which makes screenshots and manual QA reproducible.
 */

const FIRST_NAMES = [
  'Ava',
  'Liam',
  'Noah',
  'Emma',
  'Olivia',
  'Mateo',
  'Sofia',
  'Ethan',
  'Mia',
  'Lucas',
  'Zoe',
  'Kai',
  'Priya',
  'Omar',
  'Chen',
  'Aisha',
  'Diego',
  'Nora',
  'Felix',
  'Ines',
  'Jonas',
  'Layla',
  'Theo',
  'Amara',
  'Hugo',
  'Sana',
  'Leo',
  'Yuki',
  'Mila',
  'Arjun',
  'Freya',
  'Kwame',
  'Elena',
  'Tariq',
  'Ruby',
  'Ivan',
  'Naomi',
  'Bilal',
  'Clara',
  'Amir',
];
const LAST_NAMES = [
  'Nguyen',
  'Garcia',
  'Muller',
  'Kowalski',
  'Rossi',
  'Andersson',
  'Kim',
  'Diallo',
  'Silva',
  'Novak',
  'Haddad',
  'Okafor',
  'Petrov',
  'Larsen',
  'Suzuki',
  'Costa',
  'Weber',
  'Yilmaz',
  'Rahman',
  'Dubois',
  'Fernandez',
  'Ivanova',
  'Kobayashi',
  'Osei',
  'Schmidt',
  'Nakamura',
  'Popescu',
  'Almeida',
  'Berg',
  'Hassan',
];
const COMPANY_ROOTS = [
  'Northwind',
  'Bluepeak',
  'Cascade',
  'Ironleaf',
  'Solace',
  'Vertex',
  'Fernbridge',
  'Harborlight',
  'Tidewater',
  'Clearline',
  'Redshift',
  'Amberwood',
  'Silverline',
  'Northgate',
  'Brightfield',
  'Stonecrest',
  'Wavelength',
  'Grovepoint',
  'Meridian',
  'Fairwind',
  'Copperhill',
  'Lanternworks',
  'Greysail',
  'Sunforge',
  'Palewater',
  'Oakmoor',
  'Driftline',
  'Emberfall',
  'Coldharbor',
  'Warmspring',
];
const COMPANY_SUFFIXES = [
  'Labs',
  'Studio',
  'Collective',
  'Group',
  'Partners',
  'Media',
  'Works',
  'Digital',
  'Co.',
  'Systems',
];
const INDUSTRIES = [
  'E-commerce',
  'SaaS',
  'Media & Entertainment',
  'Health & Wellness',
  'Fintech',
  'Education',
  'Consumer Goods',
  'Travel',
  'Gaming',
  'Nonprofit',
];
const JOB_TITLES = [
  'Marketing Manager',
  'Founder',
  'Head of Growth',
  'Community Manager',
  'Sales Director',
  'Content Lead',
  'Operations Manager',
  'CEO',
  'Partnerships Lead',
  'Customer Success Manager',
];

/** Mulberry32 — a tiny, fast, deterministic PRNG. Good enough for demo data, not for security. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function fullName(rng: () => number): { first: string; last: string; name: string } {
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  return { first, last, name: `${first} ${last}` };
}

export function companyName(rng: () => number): string {
  return `${pick(rng, COMPANY_ROOTS)} ${pick(rng, COMPANY_SUFFIXES)}`;
}

export function domainOf(company: string): string {
  return `${company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`;
}

export function jobTitle(rng: () => number): string {
  return pick(rng, JOB_TITLES);
}

export function industry(rng: () => number): string {
  return pick(rng, INDUSTRIES);
}

const MESSAGE_SNIPPETS = [
  'Hey, do you ship internationally?',
  'Loved the last post — is this still available?',
  'What is the turnaround time on this?',
  'Can I get a discount for a bulk order?',
  'Following up on my question from last week — any update?',
  'This is exactly what I was looking for, thanks!',
  'Is there a warranty on this?',
  'How does this compare to your last release?',
  'Do you have this in a different color?',
  'Thanks for the quick reply, appreciate it.',
];
export function messageSnippet(rng: () => number): string {
  return pick(rng, MESSAGE_SNIPPETS);
}
