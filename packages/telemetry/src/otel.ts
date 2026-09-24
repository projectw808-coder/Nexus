/**
 * OpenTelemetry bootstrap shared by apps/web and apps/worker. Must be imported before any
 * instrumented module (http, ioredis, pino) is loaded — each app has an `instrumentation`
 * entry that does exactly that.
 *
 * Trace context is propagated HTTP → queue → connector HTTP call: HTTP via the standard W3C
 * `traceparent` header (auto), queue via `injectTraceCarrier()` stored on the BullMQ job
 * (see propagation.ts), outbound platform HTTP via the http instrumentation again.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export type TelemetryOptions = {
  serviceName: string;
  serviceVersion?: string;
  /** Deployment namespace (e.g. "nexus"); groups web + worker in the trace backend. */
  namespace?: string;
  /** OTLP/HTTP base endpoint, e.g. http://localhost:4318. Omit to keep spans in-process only. */
  otlpEndpoint?: string;
  /** Extra span processors (tests, Sentry bridge). */
  spanProcessors?: SpanProcessor[];
  /** Log OTel's own diagnostics (noisy; dev only). */
  debug?: boolean;
  /** Paths whose inbound HTTP spans are dropped (health probes). */
  ignoreIncomingPaths?: string[];
};

export type TelemetryHandle = {
  shutdown: () => Promise<void>;
};

let started: NodeSDK | undefined;

export function startTelemetry(opts: TelemetryOptions): TelemetryHandle {
  if (started) {
    return { shutdown: () => started?.shutdown() ?? Promise.resolve() };
  }
  if (opts.debug) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const ignore = new Set(opts.ignoreIncomingPaths ?? ['/healthz', '/readyz']);
  const spanProcessors: SpanProcessor[] = [...(opts.spanProcessors ?? [])];
  if (opts.otlpEndpoint) {
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${opts.otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    );
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.0.0',
      'service.namespace': opts.namespace ?? 'nexus',
    }),
    spanProcessors,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => {
          const path = (req.url ?? '').split('?')[0] ?? '';
          return ignore.has(path);
        },
      }),
      new IORedisInstrumentation(),
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  started = sdk;

  const shutdown = async (): Promise<void> => {
    if (!started) return;
    const s = started;
    started = undefined;
    await s.shutdown();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown();
    });
  }
  return { shutdown };
}
