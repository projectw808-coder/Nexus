/** One case per redaction level, plus the shapes strict adds on top of standard. */
import { describe, expect, it } from 'vitest';
import { redactPii } from './redact.ts';

const SAMPLE = [
  'Hi, reach me at ada@example.com or +1 (555) 123-4567.',
  'Card 4111 1111 1111 1111, SSN 123-45-6789.',
  'Ship to 221 Baker Street, London.',
].join('\n');

describe('redactPii', () => {
  it('off is a no-op', () => {
    expect(redactPii(SAMPLE, 'off')).toBe(SAMPLE);
  });

  it('standard redacts emails and phone numbers only', () => {
    const out = redactPii(SAMPLE, 'standard');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).not.toContain('ada@example.com');
    expect(out).not.toContain('555) 123-4567');
    // Not redacted at this level:
    expect(out).toContain('Baker Street');
  });

  it('strict also redacts cards, SSNs and street addresses', () => {
    const out = redactPii(SAMPLE, 'strict');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).toContain('[REDACTED_CARD]');
    expect(out).toContain('[REDACTED_SSN]');
    expect(out).toContain('[REDACTED_ADDRESS]');
    expect(out).not.toContain('4111');
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('221 Baker Street');
  });

  it('leaves ISO timestamps and ordinary prose alone', () => {
    const text = 'Order placed 2026-09-25T10:30:00.000Z, 3 units, ref A7.';
    expect(redactPii(text, 'strict')).toBe(text);
  });

  it('handles empty input', () => {
    expect(redactPii('', 'strict')).toBe('');
  });
});
