/**
 * Transactional mail behind a `MailProvider` interface (spec §3). Auth.js magic links and
 * workspace invitations go through here. SMTP (Mailpit locally) in dev/prod; an in-memory
 * provider in tests that records what would have been sent.
 */
import { loadEnv } from '@nexus/config';
import { NexusError, type Result, err, ok } from '@nexus/core';
import { createLogger } from '@nexus/telemetry';
import nodemailer, { type Transporter } from 'nodemailer';

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  /** Tag for logs and tests, e.g. "auth.magic_link", "invitation". */
  kind: string;
};

export interface MailProvider {
  send(message: MailMessage): Promise<Result<{ id: string }>>;
}

export class SmtpMailProvider implements MailProvider {
  private readonly transporter: Transporter;
  constructor(
    smtpUrl: string,
    private readonly defaultFrom: string,
  ) {
    this.transporter = nodemailer.createTransport(smtpUrl);
  }
  async send(message: MailMessage): Promise<Result<{ id: string }>> {
    try {
      const info = (await this.transporter.sendMail({
        from: message.from ?? this.defaultFrom,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      })) as { messageId?: string };
      return ok({ id: info.messageId ?? '' });
    } catch (cause) {
      return err(
        new NexusError('PLATFORM_DOWN', {
          message: 'SMTP send failed',
          context: { platformName: 'the mail server' },
          details: { kind: message.kind },
          cause,
        }),
      );
    }
  }
}

/** Postmark's HTTPS API. Preferred over SMTP: many hosts (Railway included) block outbound SMTP
 * ports entirely, so a raw `nodemailer` SMTP transport just hangs until it times out. */
export class PostmarkMailProvider implements MailProvider {
  constructor(
    private readonly serverToken: string,
    private readonly defaultFrom: string,
  ) {}
  async send(message: MailMessage): Promise<Result<{ id: string }>> {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.serverToken,
        },
        body: JSON.stringify({
          From: message.from ?? this.defaultFrom,
          To: message.to,
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
        }),
      });
      const body = (await res.json()) as { MessageID?: string; Message?: string };
      if (!res.ok) {
        throw new Error(body.Message ?? `Postmark responded ${res.status}`);
      }
      return ok({ id: body.MessageID ?? '' });
    } catch (cause) {
      return err(
        new NexusError('PLATFORM_DOWN', {
          message: 'Postmark send failed',
          context: { platformName: 'the mail server' },
          details: { kind: message.kind },
          cause,
        }),
      );
    }
  }
}

/** Records messages instead of sending them. Used by tests and when no SMTP_URL is set. */
export class MemoryMailProvider implements MailProvider {
  readonly sent: MailMessage[] = [];
  private readonly log = createLogger({ name: 'mail', level: 'info' });
  async send(message: MailMessage): Promise<Result<{ id: string }>> {
    this.sent.push(message);
    if (process.env['NODE_ENV'] !== 'test') {
      // Development without an SMTP server: print the message so links (magic link,
      // invitation) can be followed from the terminal. Never enabled in production builds.
      this.log.warn(
        { to: message.to, kind: message.kind, subject: message.subject, body: message.text },
        'no SMTP_URL set — mail recorded, not sent',
      );
    }
    return ok({ id: `memory-${this.sent.length}` });
  }
  /** Last message of a kind, for tests. */
  last(kind: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.kind === kind);
  }
}

let provider: MailProvider | undefined;

export function getMailProvider(): MailProvider {
  if (provider) return provider;
  const env = loadEnv();
  if (env.NODE_ENV === 'test') {
    provider = new MemoryMailProvider();
  } else if (env.POSTMARK_SERVER_TOKEN) {
    provider = new PostmarkMailProvider(env.POSTMARK_SERVER_TOKEN, env.EMAIL_FROM);
  } else if (env.SMTP_URL) {
    provider = new SmtpMailProvider(env.SMTP_URL, env.EMAIL_FROM);
  } else {
    provider = new MemoryMailProvider();
  }
  return provider;
}

/** Test hook: swap the provider (e.g. for a MemoryMailProvider you can inspect). */
export function setMailProvider(next: MailProvider | undefined): void {
  provider = next;
}

/** Minimal HTML escaping for templates that interpolate user-controlled strings. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
