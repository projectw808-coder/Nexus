/**
 * The sign-in (magic link) email. Pure: no I/O, no env. Both parts are short, the link sits on
 * its own line, and every interpolated string is escaped in the HTML part.
 *
 * React Email is deferred; this is hand-written HTML with inline styles because that is what
 * mail clients reliably render.
 */
import { escapeHtml } from '@/lib/mail/provider';

export type MagicLinkInput = {
  /** The full sign-in URL Auth.js generated (carries the token). */
  url: string;
  /** Host shown to the reader so they can tell where the link leads, e.g. "app.nexus.local". */
  host: string;
  /** When the link stops working. Used only for the "expires in" wording. */
  expires?: Date;
  /** Injectable clock for tests. */
  now?: Date;
};

export type MailContent = { subject: string; html: string; text: string };

const ONE_HOUR_MS = 60 * 60 * 1000;

function expiresIn({ expires, now }: Pick<MagicLinkInput, 'expires' | 'now'>): string {
  if (!expires) return '24 hours';
  const ms = expires.getTime() - (now ?? new Date()).getTime();
  const hours = Math.max(1, Math.round(ms / ONE_HOUR_MS));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

export function magicLinkEmail(input: MagicLinkInput): MailContent {
  const validFor = expiresIn(input);
  const host = escapeHtml(input.host);
  const url = escapeHtml(input.url);

  const subject = `Sign in to Nexus`;

  const text = [
    'Sign in to Nexus',
    '',
    `Use this link to sign in on ${input.host}:`,
    '',
    input.url,
    '',
    `The link expires in ${validFor} and works once. If you did not request it, you can ignore this email.`,
    '',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<body style="margin:0;padding:24px;font-family:-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111111;background:#ffffff">',
    `<p style="margin:0 0 16px">Use the link below to sign in to Nexus on <strong>${host}</strong>.</p>`,
    `<p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;padding:10px 16px;background:#111111;color:#ffffff;text-decoration:none;border-radius:6px">Sign in</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#555555">Or paste this link into your browser:<br><a href="${url}" style="color:#111111;word-break:break-all">${url}</a></p>`,
    `<p style="margin:0;font-size:13px;color:#555555">The link expires in ${validFor} and works once. If you did not request it, you can ignore this email.</p>`,
    '</body>',
    '</html>',
  ].join('\n');

  return { subject, html, text };
}
