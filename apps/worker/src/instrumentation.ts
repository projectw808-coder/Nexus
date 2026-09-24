/**
 * First import of the worker. Starts OpenTelemetry before http/ioredis/pino are loaded so the
 * auto-instrumentations can patch them. Keep this file free of other imports.
 */
import { loadEnv } from '@nexus/config';
import { startTelemetry } from '@nexus/telemetry';

const env = loadEnv();
startTelemetry({
  serviceName: 'nexus-worker',
  serviceVersion: process.env['npm_package_version'],
  namespace: env.OTEL_SERVICE_NAMESPACE,
  otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
});
