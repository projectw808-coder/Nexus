/**
 * The failure taxonomy from spec §9.2, as a typed map. Every failure that crosses a boundary
 * (platform HTTP, queue, DB, preflight) is classified into one of these codes; the map tells the
 * sync engine how to behave and tells the UI what to say. Connectors never invent free-form
 * error strings — they pick a class and fill the context.
 */

export const FAILURE_CLASSES = [
  'AUTH_EXPIRED',
  'SCOPE_MISSING',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'PLATFORM_DOWN',
  'SCHEMA_DRIFT',
  'POLICY_BLOCKED',
  'DUPLICATE',
  'VALIDATION',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'INTERNAL',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** What the engine does when it sees this class. */
export type FailureBehaviour =
  | 'pause_connection' // stop every lane on this connection until a human reconnects
  | 'disable_capability' // keep syncing, switch off just the capability that lacks scope
  | 'backoff_requeue' // exponential backoff with full jitter, keep the interactive lane alive
  | 'halt_until_reset' // stop non-interactive work until the platform's quota resets
  | 'circuit_open' // open the (connection, endpoint) breaker; probe half-open later
  | 'quarantine' // persist raw, mark object for attention, do not retry blindly
  | 'block_at_preflight' // never enqueue; surface inline before the user acts
  | 'noop' // idempotency hit — nothing to do, nothing to show
  | 'reject' // caller error; do not retry
  | 'fail'; // unexpected; retry per policy, then dead-letter

/** Placeholders a connector or job fills in so the user sees a specific sentence, not a code. */
export type FailureContext = {
  platformName?: string; // "Instagram"
  connectionLabel?: string; // "Acme — Instagram (@acmehq)"
  expiredAt?: Date;
  scope?: string; // "instagram_manage_comments"
  capability?: string; // "Comment replies"
  resumesAt?: Date;
  resetsAt?: Date;
  resetTimezone?: string; // "PT"
  usagePercent?: number;
  count?: number; // quarantined items
  reason?: string; // free text for POLICY_BLOCKED / VALIDATION
  detail?: string;
};

export type FailureSpec = {
  behaviour: FailureBehaviour;
  retryable: boolean;
  /** Status used when the failure is surfaced over HTTP (REST v1 uses RFC 9457 Problem Details). */
  httpStatus: number;
  /** One sentence for a status pill / toast. */
  userMessage: (ctx: FailureContext) => string;
  /** What the user can do about it. Rendered next to the message, often with a button. */
  remediation: (ctx: FailureContext) => string;
};

const platform = (ctx: FailureContext): string => ctx.platformName ?? 'the platform';
const clock = (d: Date | undefined, fallback: string): string =>
  d ? d.toISOString().slice(11, 16) : fallback;

export const FAILURE_TAXONOMY: Readonly<Record<FailureClass, FailureSpec>> = {
  AUTH_EXPIRED: {
    behaviour: 'pause_connection',
    retryable: false,
    httpStatus: 401,
    userMessage: (c) =>
      `Reconnect ${platform(c)} — your access expired${
        c.expiredAt ? ` on ${c.expiredAt.toISOString().slice(0, 10)}` : ''
      }.`,
    remediation: (c) => `Reconnect ${c.connectionLabel ?? platform(c)} to resume syncing.`,
  },
  SCOPE_MISSING: {
    behaviour: 'disable_capability',
    retryable: false,
    httpStatus: 403,
    userMessage: (c) =>
      `${c.capability ?? 'This feature'} need${c.capability ? 's' : 's'} ${
        c.scope ? `\`${c.scope}\`` : 'an additional permission'
      }.`,
    remediation: (c) => `Re-authorize ${platform(c)} to grant ${c.scope ?? 'the missing scope'}.`,
  },
  RATE_LIMITED: {
    behaviour: 'backoff_requeue',
    retryable: true,
    httpStatus: 429,
    userMessage: (c) =>
      `Syncing slowly — ${platform(c)} quota at ${c.usagePercent ?? 100}%, resumes ${clock(
        c.resumesAt,
        'shortly',
      )}.`,
    remediation: () =>
      'Nothing to do; background sync yields to live replies and resumes automatically.',
  },
  QUOTA_EXHAUSTED: {
    behaviour: 'halt_until_reset',
    retryable: true,
    httpStatus: 429,
    userMessage: (c) =>
      `${platform(c)} daily quota used. Resets ${clock(c.resetsAt, 'at the next window')}${
        c.resetTimezone ? ` ${c.resetTimezone}` : ''
      }.`,
    remediation: (c) =>
      `Reduce enabled resources or request a quota increase from ${platform(
        c,
      )}. Live replies still work while quota remains.`,
  },
  PLATFORM_DOWN: {
    behaviour: 'circuit_open',
    retryable: true,
    httpStatus: 503,
    userMessage: (c) => `${platform(c)} is having problems. Retrying.`,
    remediation: () => 'No action needed. We back off and probe again automatically.',
  },
  SCHEMA_DRIFT: {
    behaviour: 'quarantine',
    retryable: false,
    httpStatus: 422,
    userMessage: (c) => `${c.count ?? 1} item${(c.count ?? 1) === 1 ? '' : 's'} need attention.`,
    remediation: () =>
      'The platform changed its response shape. The raw payloads are kept; open the raw viewer and replay after the connector is updated.',
  },
  POLICY_BLOCKED: {
    behaviour: 'block_at_preflight',
    retryable: false,
    httpStatus: 409,
    userMessage: (c) => c.reason ?? 'This message cannot be sent right now.',
    remediation: (c) =>
      c.detail ?? 'Wait for the person to message you again, or use a permitted message type.',
  },
  DUPLICATE: {
    behaviour: 'noop',
    retryable: false,
    httpStatus: 200,
    userMessage: () => '',
    remediation: () => '',
  },
  VALIDATION: {
    behaviour: 'reject',
    retryable: false,
    httpStatus: 400,
    userMessage: (c) => c.reason ?? 'The request was invalid.',
    remediation: (c) => c.detail ?? 'Correct the highlighted fields and try again.',
  },
  NOT_FOUND: {
    behaviour: 'reject',
    retryable: false,
    httpStatus: 404,
    userMessage: () => 'Not found.',
    remediation: () =>
      'Check the identifier; the item may have been deleted or belongs to another workspace.',
  },
  FORBIDDEN: {
    behaviour: 'reject',
    retryable: false,
    httpStatus: 403,
    userMessage: () => 'You do not have permission to do that.',
    remediation: () => 'Ask a workspace admin for access to this platform or object.',
  },
  CONFLICT: {
    behaviour: 'reject',
    retryable: false,
    httpStatus: 409,
    userMessage: (c) => c.reason ?? 'The item changed while you were editing it.',
    remediation: () => 'Reload and apply your change again.',
  },
  INTERNAL: {
    behaviour: 'fail',
    retryable: true,
    httpStatus: 500,
    userMessage: () => 'Something went wrong on our side.',
    remediation: () =>
      'We have been notified. If this persists, contact support with the trace id.',
  },
};

export class NexusError extends Error {
  override readonly name = 'NexusError';
  readonly code: FailureClass;
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly remediation: string;
  readonly context: FailureContext;
  /** Machine-readable extras (platform error code, endpoint, status), safe to persist. Never secrets. */
  readonly details: Record<string, unknown>;

  constructor(
    code: FailureClass,
    options: {
      message?: string;
      context?: FailureContext;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    const spec = FAILURE_TAXONOMY[code];
    const context = options.context ?? {};
    super(options.message ?? spec.userMessage(context) ?? code, { cause: options.cause });
    this.code = code;
    this.retryable = spec.retryable;
    this.httpStatus = spec.httpStatus;
    this.userMessage = spec.userMessage(context);
    this.remediation = spec.remediation(context);
    this.context = context;
    this.details = options.details ?? {};
  }

  get behaviour(): FailureBehaviour {
    return FAILURE_TAXONOMY[this.code].behaviour;
  }

  /** Shape persisted to IntegrationError / SyncRun and returned by the API. No stack, no cause. */
  toJSON(): {
    code: FailureClass;
    message: string;
    userMessage: string;
    remediation: string;
    retryable: boolean;
    details: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      remediation: this.remediation,
      retryable: this.retryable,
      details: this.details,
    };
  }

  static is(value: unknown): value is NexusError {
    return value instanceof NexusError;
  }

  /** Wrap anything thrown into a NexusError without losing an existing classification. */
  static from(cause: unknown, fallback: FailureClass = 'INTERNAL'): NexusError {
    if (cause instanceof NexusError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new NexusError(fallback, { message, cause });
  }
}

/** §9.2: never retry a 4xx that is not 408/429. */
export function isRetryableHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Default classification of a bare HTTP status. Connectors refine this with platform error
 * bodies (e.g. Meta code 190 → AUTH_EXPIRED, 10/200-299 → SCOPE_MISSING).
 */
export function classifyHttpStatus(status: number): FailureClass {
  if (status === 401) return 'AUTH_EXPIRED';
  if (status === 403) return 'SCOPE_MISSING';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 422) return 'VALIDATION';
  if (status >= 500) return 'PLATFORM_DOWN';
  if (status >= 400) return 'VALIDATION';
  return 'INTERNAL';
}
