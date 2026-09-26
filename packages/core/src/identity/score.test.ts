import { describe, expect, it } from 'vitest';
import {
  domainOfEmail,
  normalizeHandle,
  normalizeName,
  normalizePhone,
  normalizeProfileUrl,
  phonesMatch,
  trigramSimilarity,
  urlsInText,
} from './normalize.ts';
import { scorePair, subjectBuilder } from './score.ts';

describe('normalisers', () => {
  it('phones: E.164, national and 00-prefixed forms', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('0044 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('07700 900123')).toBe('07700900123');
    expect(normalizePhone('123')).toBeNull();
    expect(phonesMatch('+447700900123', '07700900123')).toBe(true);
    expect(phonesMatch('+447700900123', '+447700900124')).toBe(false);
    expect(phonesMatch('+15550100', '5550100')).toBe(false); // too short to trust
  });
  it('handles, names, domains and profile urls', () => {
    expect(normalizeHandle('@Jane.Doe_')).toBe('jane.doe_');
    expect(normalizeName('  Émilie   Dupont-Roux ')).toBe('emilie dupont roux');
    expect(domainOfEmail('jane@Acme.COM')).toBe('acme.com');
    expect(domainOfEmail('jane@gmail.com')).toBeNull();
    expect(normalizeProfileUrl('https://www.instagram.com/Jane/?hl=en')).toBe('instagram.com/jane');
    expect(normalizeProfileUrl('https://instagram.com/')).toBeNull();
    expect(urlsInText('links: https://x.com/jane and linktr.ee/jane!')).toEqual([
      'https://x.com/jane',
      'linktr.ee/jane!',
    ]);
  });
  it('trigram similarity behaves like pg_trgm', () => {
    expect(trigramSimilarity('jane doe', 'jane doe')).toBe(1);
    expect(trigramSimilarity('jane doe', 'jane d')).toBeGreaterThan(0.5);
    expect(trigramSimilarity('jane doe', 'john smith')).toBeLessThan(0.2);
    expect(trigramSimilarity('', 'x')).toBe(0);
  });
});

describe('scorePair', () => {
  const person = () =>
    subjectBuilder('record', 'p1', 'Jane Doe')
      .name('Jane Doe')
      .email('jane@acme.com')
      .phone('+447700900123')
      .handle('INSTAGRAM', 'jane.doe')
      .profileUrl('https://instagram.com/jane.doe');

  it('tier 1: an e-mail match is 1.0 and auto', () => {
    const id = subjectBuilder('identity', 'i1', '@jd').email('JANE@acme.com').build();
    const r = scorePair(person().build(), id);
    expect(r.score).toBe(1);
    expect(r.decision).toBe('auto');
    expect(r.method).toBe('EXACT_EMAIL');
    expect(r.signals.map((s) => s.kind)).toEqual(['EXACT_EMAIL']);
  });
  it('tier 1: a national phone matches the E.164 one', () => {
    const id = subjectBuilder('identity', 'i1', 'x').phone('07700 900123').build();
    expect(scorePair(person().build(), id).decision).toBe('auto');
  });
  it('tier 1: platform-provided linkage', () => {
    const p = person().externalId('FACEBOOK', 'psid_1').build();
    const id = subjectBuilder('identity', 'i2', 'x')
      .externalId('INSTAGRAM', 'igsid_9')
      .linked('FACEBOOK', 'psid_1')
      .build();
    const r = scorePair(p, id);
    expect(r.method).toBe('PLATFORM_PROVIDED');
    expect(r.decision).toBe('auto');
  });
  it('tier 2: one corroborated handle alone is 0.85 → suggest', () => {
    const id = subjectBuilder('identity', 'i1', '@jane.doe')
      .handle('X', 'Jane.Doe')
      .name('jane doe')
      .build();
    const r = scorePair(person().build(), id);
    expect(r.signals.map((s) => s.kind)).toEqual(['HANDLE_MATCH']);
    expect(r.score).toBe(0.85);
    expect(r.decision).toBe('suggest');
  });
  it('tier 2: two tier-2 signals clear 0.9 → auto', () => {
    const id = subjectBuilder('identity', 'i1', '@jane.doe')
      .handle('X', 'jane.doe')
      .name('Jane Doe')
      .bioUrl('https://www.instagram.com/jane.doe/')
      .build();
    const r = scorePair(person().build(), id);
    expect(r.tier2).toBe(2);
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.decision).toBe('auto');
  });
  it('tier 2: a bio link alone is 0.9 but only one tier-2 signal → suggest', () => {
    const id = subjectBuilder('identity', 'i1', 'x').bioUrl('instagram.com/jane.doe').build();
    const r = scorePair(person().build(), id);
    expect(r.score).toBe(0.9);
    expect(r.decision).toBe('suggest');
  });
  it('tier 2: same company domain + same name', () => {
    const other = subjectBuilder('record', 'p2', 'Jane Doe')
      .name('jane doe')
      .email('j.doe@acme.com')
      .build();
    const r = scorePair(person().build(), other);
    expect(r.signals.some((s) => s.kind === 'DOMAIN_NAME')).toBe(true);
    expect(r.decision).toBe('suggest');
  });
  it('tier 3: fuzzy name never auto-merges, even with locale', () => {
    const jon = () =>
      subjectBuilder('record', 'p3', 'Jonathan Appleseed').name('Jonathan Appleseed');
    const id = subjectBuilder('identity', 'i1', 'x')
      .name('Jonathan Appleseed Jr')
      .locale('en-GB')
      .build();
    const r = scorePair(jon().locale('en_GB').build(), id);
    expect(r.signals[0]?.kind).toBe('NAME_FUZZY_LOCALE');
    expect(r.score).toBe(0.6);
    expect(r.decision).toBe('suggest');
    const bare = scorePair(
      jon().build(),
      subjectBuilder('identity', 'i', 'x').name('Jonathan Appleseed Jr').build(),
    );
    expect(bare.score).toBe(0.4);
    expect(bare.decision).toBe('suggest');
  });
  it('tier 3: an uncorroborated handle is a weak signal', () => {
    const id = subjectBuilder('identity', 'i1', 'x').handle('TIKTOK', 'jane.doe').build();
    const r = scorePair(person().build(), id);
    expect(r.signals[0]?.kind).toBe('HANDLE_ONLY');
    expect(r.decision).toBe('suggest');
  });
  it('nothing in common → none', () => {
    const id = subjectBuilder('identity', 'i1', 'x').name('Bob Stone').build();
    expect(scorePair(person().build(), id).decision).toBe('none');
  });
  it('tier 3: a similar bio embedding is a weak signal, only when supplied', () => {
    const id = subjectBuilder('identity', 'i1', 'x').name('Bob Stone').build();
    expect(scorePair(person().build(), id, 0.9).signals[0]?.kind).toBe('BIO_EMBEDDING');
    expect(scorePair(person().build(), id, 0.9).decision).toBe('suggest');
    expect(scorePair(person().build(), id).decision).toBe('none');
    expect(scorePair(person().build(), id, 0.5).decision).toBe('none');
  });
  it('is symmetric', () => {
    const a = person().build();
    const b = subjectBuilder('identity', 'i1', 'x')
      .handle('X', 'jane.doe')
      .name('jane doe')
      .build();
    expect(scorePair(a, b).score).toBe(scorePair(b, a).score);
  });
});
