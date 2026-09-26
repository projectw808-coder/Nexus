import { describe, expect, it } from 'vitest';
import { reconnectRequiredEmail } from './reconnect-required.ts';

describe('reconnectRequiredEmail', () => {
  it('names the connection and links to the reconnect URL in both parts', () => {
    const mail = reconnectRequiredEmail({
      workspaceName: 'Acme',
      connectionLabel: 'Acme — Instagram (@acmehq)',
      platformName: 'Instagram',
      expiresAt: new Date('2026-10-05T00:00:00Z'),
      reconnectUrl: 'https://app.nexus.local/w/acme/settings/integrations',
      now: new Date('2026-09-25T00:00:00Z'),
    });
    expect(mail.subject).toBe('Reconnect Instagram for Acme');
    expect(mail.text).toContain('Acme — Instagram (@acmehq)');
    expect(mail.text).toContain('https://app.nexus.local/w/acme/settings/integrations');
    expect(mail.html).toContain('href="https://app.nexus.local/w/acme/settings/integrations"');
    expect(mail.html).toContain('Acme — Instagram (@acmehq)');
  });

  it('escapes HTML in interpolated strings', () => {
    const mail = reconnectRequiredEmail({
      workspaceName: '<b>evil</b>',
      connectionLabel: '<script>alert(1)</script>',
      platformName: 'Instagram',
      expiresAt: new Date('2026-10-05T00:00:00Z'),
      reconnectUrl: 'https://x.test/a?b=1"><script>alert(1)</script>',
      now: new Date('2026-09-25T00:00:00Z'),
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>evil</b>');
    expect(mail.html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(mail.html).toContain('&lt;script&gt;');
    // The text part is not HTML, so it carries the strings verbatim.
    expect(mail.text).toContain('<b>evil</b>');
  });

  it('says access has already expired when expiresAt is null', () => {
    const mail = reconnectRequiredEmail({
      workspaceName: 'Acme',
      connectionLabel: 'Acme — X (@acmehq)',
      platformName: 'X',
      expiresAt: null,
      reconnectUrl: 'https://app.nexus.local/w/acme/settings/integrations',
    });
    expect(mail.text).toContain('Access has already expired.');
    expect(mail.html).toContain('Access has already expired.');
  });

  it('says access has already expired when expiresAt is in the past relative to `now`', () => {
    const mail = reconnectRequiredEmail({
      workspaceName: 'Acme',
      connectionLabel: 'Acme — X (@acmehq)',
      platformName: 'X',
      expiresAt: new Date('2026-09-20T00:00:00Z'),
      now: new Date('2026-09-25T00:00:00Z'),
      reconnectUrl: 'https://app.nexus.local/w/acme/settings/integrations',
    });
    expect(mail.text).toContain('Access has already expired.');
    expect(mail.html).toContain('Access has already expired.');
  });

  it('states the future expiry date when the token has not expired yet', () => {
    const mail = reconnectRequiredEmail({
      workspaceName: 'Acme',
      connectionLabel: 'Acme — X (@acmehq)',
      platformName: 'X',
      expiresAt: new Date('2026-09-28T00:00:00Z'),
      now: new Date('2026-09-25T00:00:00Z'),
      reconnectUrl: 'https://app.nexus.local/w/acme/settings/integrations',
    });
    expect(mail.text).toContain('Access expires on Mon, 28 Sep 2026');
    expect(mail.html).toContain('Access expires on Mon, 28 Sep 2026');
  });
});
