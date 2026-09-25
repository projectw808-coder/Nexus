/**
 * The mock platform hosted inside the web process for end-to-end runs (spec §15 e2e path:
 * "connect a mock platform → backfill → an inbound webhook appears in the inbox → …").
 * Only built when E2E_AUTH_BYPASS is on (ADR-012); `/api/e2e/mock/*` routes requests here,
 * `MOCK_PLATFORM_URL` points the connector at that route, and emitted webhooks are delivered
 * back to this app's `/api/webhooks/mock` over HTTP like a real platform would.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@nexus/config';
import { createMockPlatform } from '@nexus/connector-mock';

type Mock = ReturnType<typeof createMockPlatform>;
const g = globalThis as { __nexusE2eMock?: Mock; __nexusE2eMockLog?: string[] };

/** The last requests the hosted mock served (and webhook deliveries), for failing specs. */
export function e2eMockLog(): string[] {
  g.__nexusE2eMockLog ??= [];
  return g.__nexusE2eMockLog;
}

export function logMock(line: string): void {
  const log = e2eMockLog();
  log.push(`${new Date().toISOString()} ${line}`);
  if (log.length > 80) log.splice(0, log.length - 80);
}

export function getE2eMock(): Mock | null {
  const env = loadEnv();
  if (!env.E2E_AUTH_BYPASS) return null;
  if (!g.__nexusE2eMock) {
    const mock = createMockPlatform({
      baseUrl: env.MOCK_PLATFORM_URL,
      clientId: env.MOCK_CLIENT_ID,
      clientSecret: env.MOCK_CLIENT_SECRET,
      webhookSecret: env.MOCK_WEBHOOK_SECRET,
      totalObjects: 60,
      accounts: 1,
      seed: 7,
      // Random per process: this instance restarts with the server, the database does not.
      runtimeIdSuffix: `_${randomUUID().slice(0, 8)}`,
    });
    mock.onWebhook(async (req) => {
      const res = await fetch(`${env.APP_URL}${req.path}`, {
        method: 'POST',
        headers: req.headers,
        body: typeof req.rawBody === 'string' ? req.rawBody : new Uint8Array(req.rawBody),
      });
      logMock(`webhook POST ${req.path} -> ${res.status}`);
    });
    g.__nexusE2eMock = mock;
    logMock(`instance created pid=${process.pid} base=${env.MOCK_PLATFORM_URL}`);
  }
  return g.__nexusE2eMock;
}
