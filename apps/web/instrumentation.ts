/**
 * Next.js instrumentation hook — runs once when the server boots, before requests.
 * Starts the shared OpenTelemetry SDK so every request gets an HTTP server span that queue
 * jobs can join (see @nexus/telemetry propagation).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const [{ startTelemetry }, { loadEnv }] = await Promise.all([
    import('@nexus/telemetry'),
    import('@nexus/config'),
  ]);
  const env = loadEnv();
  startTelemetry({
    serviceName: 'nexus-web',
    serviceVersion: process.env['npm_package_version'],
    namespace: env.OTEL_SERVICE_NAMESPACE,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
}
