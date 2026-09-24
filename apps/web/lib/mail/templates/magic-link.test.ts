import { describe, expect, it } from 'vitest';
import { magicLinkEmail } from '@/lib/mail/templates/magic-link';

const URL_WITH_QUERY =
  'https://app.nexus.local/api/auth/callback/email?callbackUrl=%2F&token=abc123&email=ada%40example.com';

describe('magicLinkEmail', () => {
  it('includes the link in both the text and html parts', () => {
    const mail = magicLinkEmail({ url: URL_WITH_QUERY, host: 'app.nexus.local' });

    // Text: the raw URL on a line of its own.
    expect(mail.text.split('\n')).toContain(URL_WITH_QUERY);

    // HTML: the URL is attribute-escaped (the `&` in the query string becomes `&amp;`)
    // and appears both as the button href and as visible text.
    const escaped = URL_WITH_QUERY.replaceAll('&', '&amp;');
    expect(mail.html).toContain(`href="${escaped}"`);
    expect(mail.html).toContain(`>${escaped}</a>`);
    expect(mail.html).not.toContain(`href="${URL_WITH_QUERY}"`);
  });

  it('escapes HTML in interpolated strings', () => {
    const mail = magicLinkEmail({
      url: 'https://x.test/a?b=1"><script>alert(1)</script>',
      host: '<b>evil</b>',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>evil</b>');
    expect(mail.html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(mail.html).toContain('&lt;script&gt;');
    // The text part is not HTML, so it carries the strings verbatim.
    expect(mail.text).toContain('<b>evil</b>');
  });

  it('states the expiry from `expires` and falls back to 24 hours', () => {
    const now = new Date('2026-09-24T10:00:00Z');
    const twoHours = magicLinkEmail({
      url: 'https://x.test/',
      host: 'x.test',
      now,
      expires: new Date('2026-09-24T12:00:00Z'),
    });
    expect(twoHours.text).toContain('expires in 2 hours');
    expect(twoHours.html).toContain('expires in 2 hours');

    const fallback = magicLinkEmail({ url: 'https://x.test/', host: 'x.test' });
    expect(fallback.text).toContain('expires in 24 hours');
    expect(fallback.subject).toBe('Sign in to Nexus');
    expect(fallback.text).toContain('If you did not request it, you can ignore this email.');
  });
});
