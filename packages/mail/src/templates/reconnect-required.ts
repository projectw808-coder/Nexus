/**
 * The reconnect-required email (Phase 9 health console, spec §5.4): sent to the workspace owner
 * when the token sweep pauses a connection because its access token has expired or will within
 * seven days and cannot be refreshed. Pure: no I/O, no env. Mirrors magic-link.ts's shape.
 */
import { escapeHtml } from '../provider.ts';
import type { MailContent } from './magic-link.ts';

export type ReconnectRequiredInput = {
  workspaceName: string;
  /** e.g. "Acme — Instagram (@acmehq)" */
  connectionLabel: string;
  /** e.g. "Instagram" */
  platformName: string;
  /** null when the token has already expired. */
  expiresAt: Date | null;
  reconnectUrl: string;
  /** Injectable clock for tests. */
  now?: Date;
};

function hasExpired(input: Pick<ReconnectRequiredInput, 'expiresAt' | 'now'>): boolean {
  if (!input.expiresAt) return true;
  return input.expiresAt.getTime() <= (input.now ?? new Date()).getTime();
}

function expiryWording(input: Pick<ReconnectRequiredInput, 'expiresAt' | 'now'>): string {
  if (hasExpired(input)) return 'Access has already expired.';
  return `Access expires on ${input.expiresAt!.toUTCString()}.`;
}

export function reconnectRequiredEmail(input: ReconnectRequiredInput): MailContent {
  const workspaceName = escapeHtml(input.workspaceName);
  const connectionLabel = escapeHtml(input.connectionLabel);
  const platformName = escapeHtml(input.platformName);
  const reconnectUrl = escapeHtml(input.reconnectUrl);
  const expiry = expiryWording(input);

  const subject = `Reconnect ${input.platformName} for ${input.workspaceName}`;

  const text = [
    `Reconnect ${input.platformName} for ${input.workspaceName}`,
    '',
    `The connection "${input.connectionLabel}" has been paused and needs to be reconnected.`,
    expiry,
    '',
    `Reconnect it here:`,
    '',
    input.reconnectUrl,
    '',
    'Other connections in this workspace are unaffected.',
    '',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<body style="margin:0;padding:24px;font-family:-apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111111;background:#ffffff">',
    `<p style="margin:0 0 16px">The <strong>${platformName}</strong> connection <strong>${connectionLabel}</strong> in <strong>${workspaceName}</strong> has been paused and needs to be reconnected.</p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#555555">${expiry}</p>`,
    `<p style="margin:0 0 16px"><a href="${reconnectUrl}" style="display:inline-block;padding:10px 16px;background:#111111;color:#ffffff;text-decoration:none;border-radius:6px">Reconnect ${platformName}</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;color:#555555">Or paste this link into your browser:<br><a href="${reconnectUrl}" style="color:#111111;word-break:break-all">${reconnectUrl}</a></p>`,
    '<p style="margin:0;font-size:13px;color:#555555">Other connections in this workspace are unaffected.</p>',
    '</body>',
    '</html>',
  ].join('\n');

  return { subject, html, text };
}
