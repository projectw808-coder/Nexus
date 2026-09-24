/**
 * Trace-context propagation across the queue boundary. The producer (a route handler, a server
 * action, another job) calls `injectTraceCarrier()` and stores the result on the BullMQ job
 * under `TRACE_CARRIER_KEY`; the processor calls `runWithTraceCarrier()` so its span becomes a
 * child of the originating request. Pure OTel API — works with whatever SDK the app started.
 */
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;

export const TRACE_CARRIER_KEY = '__trace' as const;

const TRACER_NAME = '@nexus/telemetry';

export function getTracer(name: string = TRACER_NAME): Tracer {
  return trace.getTracer(name);
}

/** Serialise the active context (traceparent/tracestate/baggage) for storage on a job. */
export function injectTraceCarrier(ctx: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(ctx, carrier);
  return carrier;
}

export function extractTraceContext(carrier: TraceCarrier | undefined): Context {
  if (!carrier) return context.active();
  return propagation.extract(context.active(), carrier);
}

/** `{ traceId, spanId }` of the active span, for log lines and API error responses. */
export function currentTraceIds(): { traceId: string; spanId: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span) return undefined;
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId };
}

/**
 * Start a consumer span whose parent comes from `carrier` and run `fn` inside it. Records the
 * exception and sets ERROR status on throw; always ends the span.
 */
export async function runWithTraceCarrier<T>(
  carrier: TraceCarrier | undefined,
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const parent = extractTraceContext(carrier);
  const tracer = getTracer();
  return tracer.startActiveSpan(
    spanName,
    { kind: SpanKind.CONSUMER, attributes },
    parent,
    async (span) => {
      try {
        const out = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return out;
      } catch (e) {
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : '',
        });
        throw e;
      } finally {
        span.end();
      }
    },
  );
}
