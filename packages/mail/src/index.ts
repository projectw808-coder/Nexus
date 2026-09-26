export {
  SmtpMailProvider,
  MemoryMailProvider,
  getMailProvider,
  setMailProvider,
  escapeHtml,
  type MailMessage,
  type MailProvider,
} from './provider.ts';
export { magicLinkEmail, type MagicLinkInput, type MailContent } from './templates/magic-link.ts';
export {
  reconnectRequiredEmail,
  type ReconnectRequiredInput,
} from './templates/reconnect-required.ts';
