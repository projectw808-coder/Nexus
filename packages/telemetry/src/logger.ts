import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/** Correlation fields every log line should carry when known (spec §15). */
export type LogContext = {
  workspaceId?: string;
  connectionId?: string;
  userId?: string;
  jobId?: string;
  requestId?: string;
  platform?: string;
};

/**
 * §5.4: tokens are never logged. These paths are redacted before serialisation, in addition to
 * connectors never placing a TokenSet on a log call in the first place.
 */
export const REDACT_PATHS = [
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'apiKey',
  'authorization',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.secret',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'headers["x-hub-signature-256"]',
] as const;

export function createLogger(opts: {
  name: string;
  level?: string;
  pretty?: boolean;
  base?: Record<string, unknown>;
}): Logger {
  const transport =
    opts.pretty === true
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined;
  return pino({
    name: opts.name,
    level: opts.level ?? 'info',
    base: { service: opts.name, ...opts.base },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    // trace_id / span_id / trace_flags are injected by @opentelemetry/instrumentation-pino
    // whenever a span is active, so log lines and traces correlate without manual plumbing.
    ...(transport ? { transport } : {}),
  });
}

/** Child logger bound to tenant/connection correlation fields. */
export function withLogContext(logger: Logger, ctx: LogContext): Logger {
  const bindings = Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined));
  return logger.child(bindings);
}
